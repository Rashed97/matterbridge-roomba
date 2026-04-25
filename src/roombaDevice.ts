/**
 * Roomba vacuum cleaner device for Matterbridge.
 * Wraps the RoboticVacuumCleaner base class and handles command routing.
 */

import { RoboticVacuumCleaner } from 'matterbridge/devices';
import { MatterbridgeServiceAreaServer } from 'matterbridge';
import { RvcRunMode, RvcCleanMode, RvcOperationalState, ServiceArea } from 'matterbridge/matter/clusters';
import type { AnsiLogger } from 'matterbridge/logger';
import type { RoombaConnection, RoombaInfo, RoombaStatus, RoombaRoomConfig, RoombaMapConfig } from './roombaConnection.js';
import { buildSupportedAreas, buildSupportedMaps } from './serviceAreaBuilder.js';
import type { RoombaFamily } from './roombaConnection.js';

/**
 * Subclass of matterbridge's RoboticVacuumCleaner that enables the
 * Matter 1.4 ServiceArea `ProgressReporting` feature on the cluster, which
 * matterbridge's default wiring doesn't turn on. PROG lets us emit a
 * per-area Pending/Operating/Skipped/Completed status — the primary signal
 * Apple Home / Google Home consume for the "currently cleaning: Living Room"
 * progress display during a multi-room mission.
 *
 * We override `createDefaultServiceAreaClusterServer` (the method the parent
 * constructor invokes at line 91 of `roboticVacuumCleaner.ts`) so the behavior
 * gets registered with both the `Maps` and `ProgressReporting` features
 * enabled from the start. Re-wiring the behavior AFTER construction doesn't
 * work — matter.js treats behaviors as unique-per-cluster and `require()` is
 * a no-op if the cluster is already installed.
 */
class RoombaVacuumCleaner extends RoboticVacuumCleaner {
  override createDefaultServiceAreaClusterServer(
    supportedAreas?: ServiceArea.Area[],
    selectedAreas?: number[],
    currentArea?: number | null,
    supportedMaps?: ServiceArea.Map[],
  ): this {
    this.behaviors.require(
      MatterbridgeServiceAreaServer.with(
        ServiceArea.Feature.Maps,
        ServiceArea.Feature.ProgressReporting,
      ),
      {
        supportedAreas: supportedAreas ?? [],
        selectedAreas: selectedAreas ?? [],
        currentArea: currentArea !== undefined ? currentArea : null,
        supportedMaps: supportedMaps ?? [],
        estimatedEndTime: null,
        // PROG initial state — empty until a mission starts. Matter spec
        // §1.17.6.5 requires this to be non-null when the feature is enabled.
        progress: [],
      },
    );
    return this;
  }
}
import {
  RUN_MODE_IDLE,
  RUN_MODE_CLEANING,
  RUN_MODE_MAPPING,
  CLEAN_MODE_VACUUM,
  CLEAN_MODE_MOP,
  CLEAN_MODE_VACUUM_THEN_MOP,
  CLEAN_MODE_DEEP_CLEAN,
  CLEAN_MODE_MAX,
  CLEAN_MODE_QUICK,
  statusToRunMode,
  statusToOperationalState,
  errorCodeToMatterError,
  batteryToChargeLevel,
} from './stateMapping.js';

// Run modes. `Mapping` triggers a training mission where the robot explores the
// floor without actually cleaning — used to build/refine the persistent map.
// Supported on every dorita980-compatible Roomba that has a pmap (j-series, s-series).
const SUPPORTED_RUN_MODES: RvcRunMode.ModeOption[] = [
  { label: 'Idle', mode: RUN_MODE_IDLE, modeTags: [{ value: RvcRunMode.ModeTag.Idle }] },
  { label: 'Cleaning', mode: RUN_MODE_CLEANING, modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }] },
  { label: 'Mapping', mode: RUN_MODE_MAPPING, modeTags: [{ value: RvcRunMode.ModeTag.Mapping }] },
];

/**
 * Build the `SupportedModes` list for RvcCleanMode based on the robot's family
 * classification. A Matter-spec-compliant implementation:
 *   - vacuum-only robots: [Vacuum]
 *   - mop-only robots (Braava m-series): [Mop]
 *   - swappable (j5/j6 with sold-separately mop reservoir): [Vacuum, Mop]
 *     Runtime gating rejects the mode that doesn't match the installed tool.
 *   - combo (j7/j9 Combo, auto-switching): [Vacuum, Mop, VacuumThenMop]
 *     Also expose DeepClean which maps to Roomba's two-pass carpet mode.
 *
 * We always include at least one entry (Matter conformance requires a non-empty
 * SupportedModes list). DeepClean is added across all vacuum-capable families
 * because `carpetBoost` is available on any Roomba with floor-type detection.
 */
interface CleanModeCapabilities {
  multiPass: boolean;
  carpetBoost: boolean;
}

function buildSupportedCleanModes(
  family: RoombaFamily,
  caps: CleanModeCapabilities,
): RvcCleanMode.ModeOption[] {
  const modes: RvcCleanMode.ModeOption[] = [];
  const addVacuum = family !== 'mop';
  const addMop = family === 'mop' || family === 'swappable' || family === 'combo';
  const addCombo = family === 'combo';

  if (addVacuum) {
    modes.push({
      label: 'Vacuum',
      mode: CLEAN_MODE_VACUUM,
      modeTags: [
        { value: RvcCleanMode.ModeTag.Vacuum },
        { value: RvcCleanMode.ModeTag.Auto },
      ],
    });
    // Quick (single pass) — gated on the robot supporting pass selection. A
    // 600-series without multi-pass would silently ignore the preference write,
    // so we just don't offer the mode.
    if (caps.multiPass) {
      modes.push({
        label: 'Quick',
        mode: CLEAN_MODE_QUICK,
        modeTags: [
          { value: RvcCleanMode.ModeTag.Vacuum },
          { value: RvcCleanMode.ModeTag.Quick },
          { value: RvcCleanMode.ModeTag.LowEnergy },
        ],
      });
    }
    // Max Power (performance boost) — gated on carpet boost support.
    if (caps.carpetBoost) {
      modes.push({
        label: 'Max Power',
        mode: CLEAN_MODE_MAX,
        modeTags: [
          { value: RvcCleanMode.ModeTag.Vacuum },
          { value: RvcCleanMode.ModeTag.Max },
        ],
      });
    }
    // Deep Clean (two-pass + carpet boost) — needs BOTH caps.
    if (caps.multiPass && caps.carpetBoost) {
      modes.push({
        label: 'Deep Clean',
        mode: CLEAN_MODE_DEEP_CLEAN,
        modeTags: [
          { value: RvcCleanMode.ModeTag.Vacuum },
          { value: RvcCleanMode.ModeTag.DeepClean },
        ],
      });
    }
  }
  if (addMop) {
    modes.push({
      label: 'Mop',
      mode: CLEAN_MODE_MOP,
      modeTags: [{ value: RvcCleanMode.ModeTag.Mop }],
    });
  }
  if (addCombo) {
    modes.push({
      label: 'Vacuum then Mop',
      mode: CLEAN_MODE_VACUUM_THEN_MOP,
      // Matter's VacuumThenMop tag is the semantic one; carry Vacuum+Mop too so
      // older controllers that only look at primary tags still understand it.
      modeTags: [
        { value: RvcCleanMode.ModeTag.VacuumThenMop },
        { value: RvcCleanMode.ModeTag.Vacuum },
        { value: RvcCleanMode.ModeTag.Mop },
      ],
    });
  }

  // Safety net — every family must contribute at least one mode for Matter
  // conformance. 'unknown' falls through to plain Vacuum.
  if (modes.length === 0) {
    modes.push({
      label: 'Vacuum',
      mode: CLEAN_MODE_VACUUM,
      modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }],
    });
  }
  return modes;
}

// Operational states.
// NOTE: `operationalStateLabel` is only allowed for manufacturer-specific IDs (128-191),
// not for the standard IDs used below — so we omit it.
const SUPPORTED_OP_STATES: RvcOperationalState.OperationalStateStruct[] = [
  { operationalStateId: RvcOperationalState.OperationalState.Stopped },
  { operationalStateId: RvcOperationalState.OperationalState.Running },
  { operationalStateId: RvcOperationalState.OperationalState.Paused },
  { operationalStateId: RvcOperationalState.OperationalState.Error },
  { operationalStateId: RvcOperationalState.OperationalState.SeekingCharger },
  { operationalStateId: RvcOperationalState.OperationalState.Charging },
  { operationalStateId: RvcOperationalState.OperationalState.Docked },
];


export class RoombaDevice {
  public readonly device: RoboticVacuumCleaner;
  /**
   * Per-area mission progress (Matter ServiceArea PROG feature). Maintained
   * alongside `currentArea` — kept in sync with selectedAreas and flushed to
   * the `progress` attribute on every transition. Written to Matter as a
   * `ProgressStruct[]` where each entry is `{areaId, status}`.
   *
   * State machine per entry:
   *   - Pending: selected but the robot hasn't reached it yet.
   *   - Operating: robot is currently in this area (matches `currentArea`).
   *   - Completed: robot has moved past the area (sqft-advance heuristic, or
   *     mission end with no error).
   *   - Skipped: iRobot-app "Skip this room" fired, mission errored partway
   *     through, or user cancelled while the area was pending.
   */
  private missionProgress: Array<{ areaId: number; status: ServiceArea.OperationalStatus }> = [];
  private endpointActive = false;
  private readonly deviceName: string;
  private readonly serialNumber: string;
  private readonly serverMode: boolean;
  private readonly rooms: RoombaRoomConfig[];
  private readonly maps: RoombaMapConfig[];
  private readonly pmapId: string | undefined;
  private readonly userPmapvId: string | undefined;
  private readonly roomCleanDurationMs: number;
  private readonly roomCleanSqft: number;
  /** Matter areaIds currently selected by the controller (from `selectAreas`). */
  private selectedAreas: number[] = [];
  /** Wall-clock time the current multi-room mission started; fallback advance signal. */
  private missionStartMs: number | undefined;
  /** Sqft cleaned at mission start; used for sqft-delta based advance (primary signal). */
  private missionStartSqft: number | undefined;
  /**
   * Highest selectedAreas index we've reached this mission. Skip commands advance
   * us decisively (e.g. room 1 → room 2); the time-based fallback must never drag
   * us back to a room we've already left. This ratchet enforces monotonic progress.
   */
  private missionMaxIndex = 0;

  private readonly family: RoombaFamily;
  private readonly iosAllRoomsWorkaround: boolean;
  private readonly exposeRobotNetworkInfo: boolean;
  private readonly overrideRobotNetworkInterfaces: boolean;
  private readonly disableRootCustomizations: boolean;
  private readonly useExtendedBasicInformation: boolean;
  /** Most recent RvcCleanMode the controller asked for. Checked at startCleaning time. */
  private pendingCleanMode: number | undefined;

  constructor(
    private readonly connection: RoombaConnection,
    private readonly log: AnsiLogger,
    serialNumber: string,
    rooms: RoombaRoomConfig[] | undefined,
    serverMode: boolean,
    pmapId?: string,
    userPmapvId?: string,
    roomCleanDurationMinutes?: number,
    roomCleanSqft?: number,
    family: RoombaFamily = 'unknown',
    maps: RoombaMapConfig[] | undefined = undefined,
    cleanCapabilities: CleanModeCapabilities = { multiPass: false, carpetBoost: false },
    iosAllRoomsWorkaround = true,
    exposeRobotNetworkInfo = true,
    overrideRobotNetworkInterfaces = false,
    disableRootCustomizations = false,
    useExtendedBasicInformation = false,
  ) {
    this.iosAllRoomsWorkaround = iosAllRoomsWorkaround;
    this.exposeRobotNetworkInfo = exposeRobotNetworkInfo;
    this.overrideRobotNetworkInterfaces = overrideRobotNetworkInterfaces;
    this.disableRootCustomizations = disableRootCustomizations;
    this.useExtendedBasicInformation = useExtendedBasicInformation;
    this.serverMode = serverMode;
    this.rooms = rooms ?? [];
    this.maps = maps ?? [];
    this.pmapId = pmapId;
    this.userPmapvId = userPmapvId;
    this.roomCleanDurationMs = Math.max(1, roomCleanDurationMinutes ?? 10) * 60_000;
    this.roomCleanSqft = Math.max(1, roomCleanSqft ?? 75);
    this.family = family;
    const supportedCleanModes = buildSupportedCleanModes(family, cleanCapabilities);
    // Prefer a Vacuum-tagged mode as the initial current value — matches what
    // every Roomba ships with when the bin is installed. For mop-only robots
    // fall back to the first (Mop) entry.
    const initialCleanMode =
      supportedCleanModes.find((m) => m.modeTags?.some((t) => t.value === RvcCleanMode.ModeTag.Vacuum))?.mode ??
      supportedCleanModes[0].mode;
    this.deviceName = connection.getDeviceName();
    this.serialNumber = serialNumber;

    const supportedAreas = buildSupportedAreas(rooms, maps);
    const supportedMaps = buildSupportedMaps(maps);
    // CurrentArea must reference a valid id in supportedAreas (or null); pick the first
    // configured area's id so Matter conformance is satisfied no matter what ids the
    // user chose.
    const currentArea = supportedAreas[0].areaId;

    // 'server' = independent Matter server node with its own QR/passcode (recommended for
    // RVC in Apple Home / Google Home). 'matter'/undefined = bridged under the aggregator.
    const mode: 'server' | 'matter' | undefined = serverMode ? 'server' : undefined;

    this.device = new RoombaVacuumCleaner(
      this.deviceName,
      serialNumber,
      mode,
      RUN_MODE_IDLE,
      SUPPORTED_RUN_MODES,
      initialCleanMode,
      supportedCleanModes,
      undefined, // currentPhase
      undefined, // phaseList
      RvcOperationalState.OperationalState.Docked,
      SUPPORTED_OP_STATES,
      supportedAreas,
      [], // selectedAreas
      currentArea,
      supportedMaps,
    );

    this.configureCommandHandlers();
    this.listenForStateUpdates();
  }

  /**
   * Apply identifying metadata (vendor, model, firmware) to the BridgedDeviceBasicInformation
   * cluster that Matterbridge adds when wrapping the device in the bridge aggregator.
   * Should be called BEFORE registering the device with Matterbridge.
   */
  applyIdentity(info: RoombaInfo, vendorName: string, modelOverride?: string): void {
    const model = modelOverride || info.sku || 'Roomba';
    const swNum = parseSoftwareVersion(info.softwareVer);
    const hwNum = parseHardwareVersion(info.hardwareVer);
    try {
      if (this.serverMode) {
        // Server mode: the device IS its own Matter server, so the controller reads
        // BasicInformation from this endpoint (not BridgedDeviceBasicInformation).
        // Matterbridge also requires productId to be set for server-mode endpoints —
        // `createDefaultBridgedDeviceBasicInformationClusterServer` clears it, so we
        // must NOT call that helper in server mode.
        this.device.createDefaultBasicInformationClusterServer(
          this.deviceName,
          this.serialNumber,
          0xfff1,
          vendorName,
          0x8000,
          model,
          swNum,
          info.softwareVer,
          hwNum,
          info.hardwareVer,
        );
      } else {
        // Bridged mode: the controller reads BridgedDeviceBasicInformation from the
        // bridged endpoint. Call both so older controllers that read BasicInformation
        // get the right vendor/model too.
        this.device.createDefaultBasicInformationClusterServer(
          this.deviceName,
          this.serialNumber,
          0xfff1,
          vendorName,
          0x8000,
          model,
          swNum,
          info.softwareVer,
          hwNum,
          info.hardwareVer,
        );
        this.device.createDefaultBridgedDeviceBasicInformationClusterServer(
          this.deviceName,
          this.serialNumber,
          0xfff1,
          vendorName,
          model,
          swNum,
          info.softwareVer,
          hwNum,
          info.hardwareVer,
        );
      }
      this.log.info(
        `Applied identity to ${this.deviceName}: vendor=${vendorName} model=${model} sw=${info.softwareVer} hw=${info.hardwareVer}`,
      );
      this.log.debug(
        `  Endpoint fields now: vendorName="${this.device.vendorName}" productName="${this.device.productName}" productId=${this.device.productId} softwareVersionString="${this.device.softwareVersionString}" uniqueId="${this.device.uniqueId}" mode=${this.serverMode ? 'server' : 'bridged'}`,
      );
      // Stash the values we want on the root node — they'll be pushed via
      // overrideRootNodeIdentity() AFTER matterbridge creates the server node, since
      // matterbridge's createServerNodeContext hardcodes softwareVersion to its OWN
      // version (e.g. 3.7.4) regardless of what we set on the endpoint.
      this.pendingRootOverride = {
        vendorName,
        productName: model,
        softwareVersion: swNum,
        softwareVersionString: info.softwareVer,
        hardwareVersion: hwNum,
        hardwareVersionString: info.hardwareVer,
        // Extra BasicInformation fields — these surface in HA's "Matter Info"
        // pane and Google Home device details; without them Google Home shows
        // "Hardware version: Unknown" even with hardwareVersionString set.
        partNumber: info.sku,
        productLabel: model,
        serialNumber: this.serialNumber,
        // Vacuum's own network details (MAC + SSID). Used to populate
        // NetworkCommissioning.Networks[] with the ROBOT's Wi-Fi, not the
        // Matterbridge host's — which is what HA's "Matter Info" actually
        // wants to show.
        robotMac: info.network.mac,
        robotSsid: info.network.ssid,
      };
    } catch (err) {
      this.log.warn(`Failed to apply device identity: ${err}`);
    }
  }

  private pendingRootOverride?: {
    vendorName: string;
    productName: string;
    softwareVersion: number;
    softwareVersionString: string;
    hardwareVersion: number;
    hardwareVersionString: string;
    partNumber?: string;
    productLabel?: string;
    serialNumber?: string;
    robotMac?: string;
    robotSsid?: string;
  };

  /**
   * In server mode each device has its own Matter server node (root endpoint 0).
   * Matterbridge unconditionally stamps its own `softwareVersion`/`hardwareVersion`
   * into that root node's BasicInformation when creating the server, so users see
   * "Matterbridge 3.7.4" instead of the robot's firmware. We work around this by
   * writing the correct values back to the root node AFTER registration.
   *
   * These attributes are declared Fixed in the Matter spec, meaning a REMOTE
   * controller cannot write them — but the server itself can populate them at any
   * time before clients subscribe. matter.js's internal `set()` API respects that.
   */
  async overrideRootNodeIdentity(): Promise<void> {
    if (!this.serverMode || !this.pendingRootOverride) return;
    if (this.disableRootCustomizations) {
      this.log.info(
        `[${this.deviceName}] disableRootCustomizations=true — skipping all root-node ` +
          `BasicInformation/NetworkCommissioning/GeneralDiagnostics customizations. ` +
          `Apple Home should see the matterbridge defaults (firmware 3.x, hardware kernel string, ` +
          `bridge MAC, no SSID). Use this to bisect iOS connectivity regressions.`,
      );
      return;
    }
    // `serverNode` is attached by matterbridge in createDeviceServerNode — it's a
    // matter.js ServerNode whose endpoint-0 `basicInformation` we need to patch.
    const serverNode = (this.device as unknown as { serverNode?: {
      set: (state: unknown) => Promise<void>;
      behaviors?: { require: (type: unknown, init: unknown) => void; has?: (type: unknown) => boolean };
    } }).serverNode;
    if (!serverNode || typeof serverNode.set !== 'function') {
      this.log.debug(`Server node not available yet for ${this.deviceName} — skipping root identity override`);
      return;
    }

    // Build the basicInformation patch. `partNumber` / `productLabel` /
    // `serialNumber` are optional-fixed in Matter §11.1.5 — Google Home and
    // HA's "Matter Info" pane both pull `hardwareVersionString` for the
    // "Hardware version" row, but HA surfaces `partNumber` and `serialNumber`
    // in the attribute list too, and some third-party controllers use
    // `productLabel` as a fallback display name.
    const basicInformation: Record<string, unknown> = {
      vendorName: this.pendingRootOverride.vendorName.slice(0, 32),
      productName: this.pendingRootOverride.productName.slice(0, 32),
      softwareVersion: this.pendingRootOverride.softwareVersion,
      softwareVersionString: this.pendingRootOverride.softwareVersionString.slice(0, 64),
      hardwareVersion: this.pendingRootOverride.hardwareVersion,
      hardwareVersionString: this.pendingRootOverride.hardwareVersionString.slice(0, 64),
    };
    // Extended fields (partNumber, productLabel, serialNumber) gated behind a
    // separate flag — Apple may be strict about writing Fixed-conformance
    // attributes on an already-commissioned device, and these are the
    // v1.7.0 additions on top of the v1.6.0 baseline that's known to work.
    if (this.useExtendedBasicInformation) {
      if (this.pendingRootOverride.partNumber) basicInformation.partNumber = this.pendingRootOverride.partNumber.slice(0, 32);
      if (this.pendingRootOverride.productLabel) basicInformation.productLabel = this.pendingRootOverride.productLabel.slice(0, 64);
      if (this.pendingRootOverride.serialNumber) basicInformation.serialNumber = this.pendingRootOverride.serialNumber.slice(0, 32);
    }

    try {
      await serverNode.set({ basicInformation });
      this.log.info(
        `Root node identity overridden for ${this.deviceName}: ` +
          `vendorName=${this.pendingRootOverride.vendorName} ` +
          `productName=${this.pendingRootOverride.productName} ` +
          `softwareVersionString=${this.pendingRootOverride.softwareVersionString}` +
          (this.useExtendedBasicInformation && this.pendingRootOverride.partNumber ? ` partNumber=${this.pendingRootOverride.partNumber}` : '') +
          (this.useExtendedBasicInformation && this.pendingRootOverride.serialNumber ? ` serialNumber=${this.pendingRootOverride.serialNumber}` : '') +
          (!this.useExtendedBasicInformation ? ' (extended fields disabled)' : ''),
      );
    } catch (err) {
      this.log.warn(`Failed to override root node identity for ${this.deviceName}: ${err}`);
    }

    // Opt-out path: skip the NetworkCommissioning + GeneralDiagnostics
    // overrides entirely. Apple Home's Home hub on some iOS builds gets
    // stuck in "Updating…" after these clusters are added to an
    // already-commissioned device — the added schema triggers a re-read
    // that Apple doesn't gracefully recover from. Other controllers
    // (Google Home, HA) tolerate it. Default ON; flip off to fall back
    // to pre-v1.7 display (host's network shown in Matter Info).
    if (!this.exposeRobotNetworkInfo) {
      this.log.info(
        `Robot network-info override disabled for ${this.deviceName} (` +
          `exposeRobotNetworkInfo=false). HA/Google Home will show the bridge's ` +
          `network info instead of the vacuum's. Toggle this back on after Apple ` +
          `Home is happy again.`,
      );
      return;
    }

    // Best-effort NetworkCommissioning attach on root — carries the ROBOT's
    // SSID in Networks[0] so it appears in HA's "Matter Info" pane and
    // Google Home device details.
    //
    // Matterbridge may have already started the server node by the time we
    // reach here; if so, `behaviors.require` may be a no-op. Logged at debug
    // so silent failure is findable but doesn't scare anyone.
    if (this.pendingRootOverride.robotSsid) {
      await this.attachWifiNetworkCommissioning(
        serverNode,
        this.pendingRootOverride.robotSsid,
      );
    }

    // GeneralDiagnostics.NetworkInterfaces override — OPT-IN ONLY.
    // Faking the NetworkInterfaces entry with the Roomba's MAC + empty
    // IP lists causes Apple Home (iOS) to get stuck in "Updating…" after
    // network transitions — likely a reachability-integrity check using
    // the MAC. Spec (§11.11.6.7) says NetworkInterfaces is diagnostic-only,
    // but Apple treats it as authoritative for routing heuristics.
    // Default: off. Enable via `overrideRobotNetworkInterfaces: true` to
    // experiment — be prepared to re-pair Apple devices after toggling.
    if (
      this.overrideRobotNetworkInterfaces &&
      (this.pendingRootOverride.robotMac || this.pendingRootOverride.robotSsid)
    ) {
      this.scheduleGeneralDiagnosticsOverride(serverNode);
    }
  }

  /**
   * Write a synthetic `GeneralDiagnostics.NetworkInterfaces` entry reflecting
   * the Roomba's own MAC / IP / WiFi state. Scheduled to run ~2s after the
   * initial override so matter.js's own `#updateNetworkList` (triggered on
   * `lifecycle.online`) has already written the host's NICs — our write
   * then supersedes it. Without the delay we lose the race.
   */
  private scheduleGeneralDiagnosticsOverride(serverNode: {
    set: (state: unknown) => Promise<void>;
  }): void {
    const robotMac = this.pendingRootOverride?.robotMac;
    setTimeout(async () => {
      try {
        // hardwareAddress expects raw bytes. Accept colon- or dash-separated
        // hex; fall back to a placeholder when MAC isn't known (the robot's
        // MQTT state may not have reported it by now on older firmware).
        const macHex = (robotMac ?? '00:00:00:00:00:00').replace(/[^0-9a-fA-F]/g, '');
        const macBytes = Buffer.from(macHex, 'hex');
        const syntheticInterface = {
          name: 'wlan0',
          isOperational: true,
          offPremiseServicesReachableIPv4: null,
          offPremiseServicesReachableIPv6: null,
          hardwareAddress: macBytes,
          // We don't have the Roomba's IPs pre-populated on pendingRootOverride
          // (they're on the RoomaInfo.network namespace which the device
          // doesn't carry). Empty lists are valid; the important fix is the
          // `type` + MAC. matter.js treats these as "device did not choose to
          // report IPs per-interface" rather than "no IPs".
          iPv4Addresses: [],
          iPv6Addresses: [],
          type: 1, // GeneralDiagnostics.InterfaceType.WiFi
        };
        await serverNode.set({
          generalDiagnostics: { networkInterfaces: [syntheticInterface] },
        });
        this.log.info(
          `Overrode GeneralDiagnostics.NetworkInterfaces with Roomba's own MAC ${robotMac ?? '(missing)'} ` +
            `+ type=WiFi — HA's "Matter Info" will show WiFi + the robot's MAC instead of the bridge's.`,
        );
      } catch (err) {
        this.log.debug(
          `GeneralDiagnostics NetworkInterfaces override failed (${err}) — ` +
            `HA will continue to show "Network type: Ethernet" + the bridge's MAC.`,
        );
      }
    }, 2_000);
  }

  /**
   * Attach a WiFi-featured NetworkCommissioning behavior to the root endpoint
   * so HA / Google Home show the Roomba's Wi-Fi SSID and network type.
   *
   * Matter §11.9 mandates 5 commands when the WiFi feature is declared:
   * `scanNetworks`, `addOrUpdateWiFiNetwork`, `removeNetwork`,
   * `connectNetwork`, `reorderNetwork`. matter.js's default implementations
   * throw "unimplemented exception" (the `ValidatedElements` warnings we
   * saw) which makes Apple Home's Home hub stick in "Updating…".
   *
   * The Roomba's network is managed out-of-band via the iRobot app — there
   * is no sensible way for Matter to (re)configure the vacuum's Wi-Fi, and
   * letting it would be a terrible idea regardless (dorita980 exposes no
   * setter for wireless config, so we couldn't act on the command anyway).
   * But the spec DOES anticipate this case: each command has a
   * `NetworkCommissioningStatus` enum with values for "device doesn't
   * support the operation" (NetworkIdNotFound, OtherConnectionFailure,
   * etc.). We override the 5 commands to return those statuses politely,
   * which turns the cluster into a read-only informational surface — fully
   * spec-compliant — and keeps the SSID visible in `Networks[0]`.
   *
   * Dynamic imports so the plugin still loads on matterbridge minors that
   * happen to drop the modules.
   */
  private async attachWifiNetworkCommissioning(
    serverNode: {
      set: (state: unknown) => Promise<void>;
      behaviors?: { require: (type: unknown, init: unknown) => void; has?: (type: unknown) => boolean };
    },
    ssid: string,
  ): Promise<void> {
    try {
      const { NetworkCommissioningServer } = await import('matterbridge/matter/behaviors');
      const { NetworkCommissioning } = await import('matterbridge/matter/clusters');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const BaseWifiNC: any = (NetworkCommissioningServer as unknown as {
        with: (...features: unknown[]) => unknown;
      }).with(NetworkCommissioning.Feature.WiFiNetworkInterface);
      const ssidBytes = Buffer.from(ssid.slice(0, 32), 'utf8');
      const Status = NetworkCommissioning.NetworkCommissioningStatus;
      const log = this.log;
      const debugMsg = 'Roomba Wi-Fi is provisioned via the iRobot app; Matter has no setter';

      // Subclass the feature-enabled base behavior and implement each
      // required command. Returns are the matter.js response shapes for
      // each command (see @matter/types/clusters/network-commissioning).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ReadOnlyWifiNC = class extends BaseWifiNC {
        // spec: return a list of visible WiFi networks. We have no way to
        // scan and no reason to; return Success + an empty result set. The
        // client gets a well-formed response and decides accordingly.
        async scanNetworks(): Promise<unknown> {
          log.debug('NetworkCommissioning.scanNetworks invoked — returning empty scan result (read-only cluster)');
          return {
            networkingStatus: Status.Success,
            debugText: debugMsg,
            wiFiScanResults: [],
            threadScanResults: [],
          };
        }
        // spec: replace or add a network. We don't accept configuration —
        // BoundsExceeded with maxNetworks=1 + the ssid already present is
        // the closest semantic match ("collection full").
        async addOrUpdateWiFiNetwork(): Promise<unknown> {
          log.debug('NetworkCommissioning.addOrUpdateWiFiNetwork rejected — read-only cluster');
          return { networkingStatus: Status.BoundsExceeded, debugText: debugMsg, networkIndex: 0 };
        }
        // spec: remove a configured network. We never have any removable
        // networks — the one entry is device-managed.
        async removeNetwork(): Promise<unknown> {
          log.debug('NetworkCommissioning.removeNetwork rejected — read-only cluster');
          return { networkingStatus: Status.NetworkIdNotFound, debugText: debugMsg, networkIndex: 0 };
        }
        // spec: initiate connection to a configured network. We're already
        // connected (see Networks[0].connected=true) and have no control
        // knob. OtherConnectionFailure tells the controller "I'm not doing
        // that" without implying a transient issue.
        async connectNetwork(): Promise<unknown> {
          log.debug('NetworkCommissioning.connectNetwork rejected — read-only cluster');
          return {
            networkingStatus: Status.OtherConnectionFailure,
            debugText: debugMsg,
            errorValue: null,
          };
        }
        // spec: reorder the network priority list. Single-entry list has
        // no order to change.
        async reorderNetwork(): Promise<unknown> {
          log.debug('NetworkCommissioning.reorderNetwork rejected — read-only cluster');
          return { networkingStatus: Status.NetworkIdNotFound, debugText: debugMsg, networkIndex: 0 };
        }
      };

      serverNode.behaviors?.require(ReadOnlyWifiNC, {
        maxNetworks: 1,
        interfaceEnabled: true,
        lastNetworkingStatus: Status.Success,
        lastNetworkId: ssidBytes,
        lastConnectErrorValue: null,
        networks: [{ networkId: ssidBytes, connected: true }],
        scanMaxTimeSeconds: 10,
        connectMaxTimeSeconds: 30,
        supportedWiFiBands: [NetworkCommissioning.WiFiBand['2G4']],
      });
      this.log.info(
        `Attached NetworkCommissioning(WiFi, read-only) to root with SSID "${ssid}" — ` +
          `commissioning commands return proper Matter statuses (no-op) per spec §11.9.`,
      );
    } catch (err) {
      this.log.debug(
        `NetworkCommissioning attach failed (${err}) — "Network type: Ethernet" ` +
          `/ missing SSID in Matter Info will persist. See README known limitations.`,
      );
    }
  }

  private configureCommandHandlers(): void {
    // Identify: make the robot beep
    this.device.addCommandHandler('identify', async () => {
      this.log.info(`Identify requested for ${this.connection.getDeviceName()}`);
      try {
        await this.connection.find();
      } catch (err) {
        this.log.warn(`Failed to identify robot: ${err}`);
      }
    });

    // RvcRunMode: change run mode (start/stop cleaning).
    // If the controller has called `selectAreas` with one or more rooms, start a
    // room-targeted clean via the dorita980 `cleanRoom` command — otherwise a whole-home
    // clean. Roomba requires pmapId + userPmapvId for room cleans; if those aren't in
    // the config the room path degrades to a whole-home clean with a log warning.
    // RvcRunMode.changeToMode: start / stop / begin mapping run.
    // Fully-qualified name because the short key 'changeToMode' also targets
    // ModeSelect and would collide with RvcCleanMode.changeToMode (whose mode
    // ids 1-4 overlap with our run-mode ids numerically).
    this.device.addCommandHandler('RvcRunMode.changeToMode', async ({ request }) => {
      const newMode = request.newMode;
      this.log.info(`RvcRunMode.changeToMode requested: ${newMode}`);
      try {
        if (newMode === RUN_MODE_CLEANING) {
          const status = this.connection.getStatus();
          if (status.paused) {
            await this.connection.resume();
          } else {
            await this.startCleaning();
          }
        } else if (newMode === RUN_MODE_MAPPING) {
          this.log.info('Starting mapping / training run');
          await this.connection.train();
        } else if (newMode === RUN_MODE_IDLE) {
          await this.connection.stop();
        }
      } catch (err) {
        this.log.warn(`Failed to change run mode: ${err}`);
      }
    });

    // RvcCleanMode.changeToMode: record which clean mode the controller wants.
    // Matterbridge computes the actual ChangeToModeResponse internally (based on
    // supportedModes) and doesn't accept a return value from the handler — so
    // we can't cleanly reject "Mop on a bin-installed swappable" at this layer.
    // Instead we remember the pending mode, and gate it in startCleaning() so
    // the user sees the denial + reason when they actually press Clean.
    this.device.addCommandHandler('RvcCleanMode.changeToMode', async ({ request }) => {
      const newMode = request.newMode;
      this.pendingCleanMode = newMode;
      this.log.info(`RvcCleanMode.changeToMode requested: ${newMode}`);
      const denial = this.validateCleanMode(newMode);
      if (denial) {
        // Log only — matterbridge's cluster server will have already accepted
        // the mode change by the time we get here. The denial is surfaced at
        // startCleaning time if the user proceeds to press Clean.
        this.log.warn(`Clean mode ${newMode} currently unavailable: ${denial.statusText}`);
      }
    });

    // ServiceArea: record which rooms the controller wants cleaned. The actual
    // clean command is sent once the controller transitions RvcRunMode to Cleaning.
    //
    // Matter spec §1.17.7.1.1: `newAreas=[]` means "unconstrained" (clean
    // everywhere). iOS Home's room picker uses this when the user picks "All
    // Rooms" — but then re-renders the ticked-rooms UI from the SelectedAreas
    // attribute and shows *only the first configured room* ticked (looks like a
    // client UI bug; macOS Home renders the same empty-list attribute as "All
    // Rooms" correctly). Workaround: when newAreas is empty, internally treat
    // it as "whole-home" (startCleaning will dispatch `clean()` not
    // `cleanRoom()`), but mirror back the FULL list of configured areaIds to
    // the attribute so iOS Home's UI matches user intent.
    this.device.addCommandHandler('selectAreas', async ({ request }) => {
      const newAreas = (request.newAreas ?? []) as number[];
      this.selectedAreas = [...newAreas];
      this.log.info(`selectAreas requested: [${newAreas.join(', ')}]`);
      const useWorkaround =
        this.iosAllRoomsWorkaround && newAreas.length === 0 && this.rooms.length > 0;
      const mirrorValue = useWorkaround
        ? this.rooms.map((r) => r.areaId)
        : this.selectedAreas;
      try {
        this.device.setAttribute('serviceArea', 'selectedAreas', mirrorValue, this.log);
      } catch (err) {
        this.log.debug(`Failed to mirror selectedAreas: ${err}`);
      }
    });

    // ServiceArea.SkipArea: not wired up yet. Matterbridge's
    // `MatterbridgeServiceAreaServer` only forwards `selectAreas` to the plugin
    // command handler; `skipArea` would need an upstream addition to
    // CommandHandlerDataMap + the server override. Dorita980 also doesn't expose
    // a `skip()` method, so the downstream half is missing too. In the meantime,
    // skip commands from the iRobot app ARE detected via `lastCommand`
    // observations and flow through `handleRegionsSkipped` → currentArea advance
    // — which covers the user-facing path today.

    // RvcOperationalState: pause, resume, goHome
    this.device.addCommandHandler('pause', async () => {
      this.log.info('Pause requested');
      try {
        await this.connection.pause();
      } catch (err) {
        this.log.warn(`Failed to pause: ${err}`);
      }
    });

    this.device.addCommandHandler('resume', async () => {
      this.log.info('Resume requested');
      try {
        await this.connection.resume();
      } catch (err) {
        this.log.warn(`Failed to resume: ${err}`);
      }
    });

    this.device.addCommandHandler('goHome', async () => {
      this.log.info('Go home requested');
      try {
        // Some Roomba firmwares auto-resume a paused mission when the robot reaches
        // the dock — it bounces off, completes, redocks, loops. Sending `stop()`
        // first cancels the active/paused mission so the subsequent `dock()` results
        // in a clean single-dock with no mission to resume.
        const status = this.connection.getStatus();
        if (status.running || status.paused) {
          this.log.debug('goHome: mission active, stopping before dock');
          try {
            await this.connection.stop();
          } catch (err) {
            this.log.debug(`goHome: stop() returned ${err}; continuing to dock anyway`);
          }
          // Brief settle time so the robot processes the stop before we tell it to dock.
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        await this.connection.dock();
      } catch (err) {
        this.log.warn(`Failed to dock: ${err}`);
      }
    });
  }

  /**
   * Check whether the robot can currently perform the requested clean mode.
   * Returns an InvalidInMode response struct when it can't (with human-readable
   * `statusText` the controller surfaces to the user), or `null` when the mode
   * is fine to proceed.
   *
   * Matter spec: ModeBase.ChangeToModeResponse statuses —
   *   0 = Success, 1 = UnsupportedMode, 2 = GenericFailure, 3 = InvalidInMode.
   * We use InvalidInMode (3) for tool-mismatch cases; the controller interprets
   * that as "not possible right now" rather than "the device doesn't support it
   * at all", which matches the semantics on a swappable robot.
   */
  private validateCleanMode(newMode: number): { status: number; statusText: string } | null {
    const tool = this.connection.getStatus().installedTool;
    // Every vacuum-power preset (Vacuum / DeepClean / Max / Quick) requires the
    // bin to be installed on a swappable robot.
    const isVacuumMode =
      newMode === CLEAN_MODE_VACUUM ||
      newMode === CLEAN_MODE_DEEP_CLEAN ||
      newMode === CLEAN_MODE_MAX ||
      newMode === CLEAN_MODE_QUICK;
    const isMopMode = newMode === CLEAN_MODE_MOP;
    const isComboMode = newMode === CLEAN_MODE_VACUUM_THEN_MOP;

    if (this.family === 'swappable') {
      if (isMopMode && !tool.mopInstalled) {
        return {
          status: 3,
          statusText: 'Swap in the mop reservoir first — the bin is currently installed.',
        };
      }
      if (isVacuumMode && !tool.binInstalled) {
        return {
          status: 3,
          statusText: 'Swap in the dust bin first — the mop reservoir is currently installed.',
        };
      }
    }
    if ((isMopMode || isComboMode) && this.family === 'combo' && tool.padFaulted) {
      return { status: 3, statusText: 'Mop pad is missing or not detected. Reseat the pad.' };
    }
    // Combo & mop-only families accept mop modes unconditionally; the robot's
    // own "pad missing" error will surface via OperationalError if the user
    // starts cleaning without one.
    return null;
  }

  /**
   * For mop-involving clean modes (Mop, VacuumThenMop), sanity-check the
   * robot's tank/pad state BEFORE we dispatch the command. Returns the Matter
   * errorStateId + human-readable statusText when the mission would fail, or
   * null when we're good to go. Vacuum-only modes always return null.
   */
  private preRunMopGuard(mode: number): { errorStateId: number; statusText: string } | null {
    const isMopMode = mode === CLEAN_MODE_MOP;
    const isComboMode = mode === CLEAN_MODE_VACUUM_THEN_MOP;
    if (!isMopMode && !isComboMode) return null;
    const status = this.connection.getStatus();
    const tool = status.installedTool;

    // Swappable robots need the mop reservoir swapped in before a mop mission.
    // Already enforced by validateCleanMode; double-check for combo/mop
    // families below.
    if (tool.padFaulted) {
      return {
        errorStateId: RvcOperationalState.ErrorState.MopCleaningPadMissing,
        statusText: 'Mop cleaning pad is missing or unreadable. Reseat the pad before starting.',
      };
    }
    // Combo / mop-only robots: tank must be present on the robot.
    if ((this.family === 'combo' || this.family === 'mop') && tool.mopInstalled === false) {
      return {
        errorStateId: RvcOperationalState.ErrorState.WaterTankMissing,
        statusText: 'Water tank is not installed. Attach the tank and retry.',
      };
    }
    // Tank installed but empty. Only check when the robot has actually
    // reported a non-zero level at some point this session (robotHasSeenTank
    // gate) — without that, a vacuum-only robot would trip this every time.
    if (this.robotHasSeenTank && status.tankLevel === 0) {
      return {
        errorStateId: RvcOperationalState.ErrorState.WaterTankEmpty,
        statusText: 'Water tank is empty. Refill and retry.',
      };
    }
    return null;
  }

  /**
   * Decide between a whole-home and a room-targeted clean based on the current
   * `selectedAreas`. Called when the controller transitions RvcRunMode -> Cleaning.
   */
  private async startCleaning(): Promise<void> {
    // Gate against tool-mismatch: swappable robots can't do Mop with the bin
    // installed or Vacuum with the mop reservoir installed. Throw early so the
    // user sees a helpful message in the log and Matter's RvcOperationalState
    // stays in whatever state it was, rather than going Running on a no-op clean.
    if (this.pendingCleanMode !== undefined) {
      const denial = this.validateCleanMode(this.pendingCleanMode);
      if (denial) {
        this.log.error(
          `Cannot start clean: selected clean mode ${this.pendingCleanMode} is unavailable — ${denial.statusText}`,
        );
        throw new Error(denial.statusText);
      }

      // Pre-run mop/water guard (Matter 1.4 §7.4.7.1 ErrorStateEnum 68-71).
      // For any mop-involving mode on a combo or mop-only robot, surface
      // MopCleaningPadMissing / WaterTankMissing / WaterTankEmpty as an
      // OperationalError + event BEFORE dispatching the clean — so the
      // controller shows a meaningful reason and the robot never starts a
      // doomed mission. Roomba firmware itself will raise these eventually
      // mid-run but by then the user is confused.
      const mopGuard = this.preRunMopGuard(this.pendingCleanMode);
      if (mopGuard) {
        this.log.error(
          `Cannot start mop/combo clean: ${mopGuard.statusText} (Matter errorStateId=${mopGuard.errorStateId})`,
        );
        // Surface the error state + event before throwing so Apple Home
        // shows the right icon/notification rather than a generic failure.
        try {
          const payload = { errorStateId: mopGuard.errorStateId, errorStateLabel: mopGuard.statusText };
          this.device.setAttribute('rvcOperationalState', 'operationalError', payload, this.log);
          await this.device.triggerEvent('rvcOperationalState', 'operationalError', payload, this.log);
        } catch (err) {
          this.log.debug(`Pre-run mop-guard error surfacing failed: ${err}`);
        }
        throw new Error(mopGuard.statusText);
      }
      // Apply the Roomba-side cleaning preset (carpet boost + passes) that
      // matches the selected Matter mode. The robot remembers these
      // persistently, so the subsequent `clean()`/`cleanRoom()` picks them up.
      const preset = matterModeToPreset(this.pendingCleanMode);
      if (preset) {
        try {
          this.log.info(`Applying cleaning preset "${preset}" for mode ${this.pendingCleanMode}`);
          await this.connection.applyCleaningPreset(preset);
        } catch (err) {
          this.log.warn(`applyCleaningPreset(${preset}) failed: ${err} (continuing with previous preset)`);
        }
      }
    }

    if (this.selectedAreas.length === 0) {
      // Whole-home clean: clear any stale per-area state from a previous room mission.
      this.log.info('Starting whole-home clean (no areas selected)');
      this.setCurrentArea(null);
      // No per-area progress to report on an unconstrained mission.
      this.missionProgress = [];
      this.flushProgress();
      await this.connection.clean();
      return;
    }
    this.log.info(
      `startCleaning: ${this.selectedAreas.length} area(s) selected: [${this.selectedAreas.join(', ')}]`,
    );

    // Resolve Matter areaIds back to Roomba region metadata, and group by map
    // so we can verify the mission doesn't cross maps (the robot can't physically
    // clean rooms on two different pmaps in one mission — they're typically
    // different floors).
    const regions: Array<{ region_id: string; type: string }> = [];
    const unmappedAreas: number[] = [];
    const selectedMapIds = new Set<number | undefined>();
    for (const areaId of this.selectedAreas) {
      const room = this.rooms.find((r) => r.areaId === areaId);
      if (!room || !room.regionId) {
        unmappedAreas.push(areaId);
        continue;
      }
      regions.push({ region_id: room.regionId, type: room.regionType ?? 'rid' });
      selectedMapIds.add(room.mapId);
    }

    if (unmappedAreas.length > 0) {
      this.log.warn(
        `selectAreas referenced Matter areaId(s) [${unmappedAreas.join(', ')}] that have no regionId in config — ` +
          `falling back to whole-home clean. Run discovery mode to capture regionIds and add them to rooms[].`,
      );
      this.setCurrentArea(null);
      await this.connection.clean();
      return;
    }

    // Cross-map check (multi-floor j9+/s9+): if the user picked rooms spanning
    // two maps we can't satisfy both in one mission. Clean only the map the
    // first selected room is on and log the skip.
    if (selectedMapIds.size > 1) {
      const firstMapId = this.rooms.find((r) => r.areaId === this.selectedAreas[0])?.mapId;
      this.log.warn(
        `selectAreas spans multiple maps ${Array.from(selectedMapIds).join(', ')}; ` +
          `only cleaning rooms on map ${firstMapId}. Move the robot to each map for the remaining rooms separately.`,
      );
      // Filter regions down to the first map's rooms.
      const filteredRegions = this.selectedAreas
        .map((id) => this.rooms.find((r) => r.areaId === id))
        .filter((r): r is RoombaRoomConfig => !!r && r.mapId === firstMapId && !!r.regionId)
        .map((r) => ({ region_id: r.regionId!, type: r.regionType ?? 'rid' }));
      regions.length = 0;
      regions.push(...filteredRegions);
    }

    // Pick the pmapId/userPmapvId for this mission. Look up from the `maps`
    // array if configured; else fall back to the device-level defaults.
    const missionMapId = this.rooms.find((r) => r.areaId === this.selectedAreas[0])?.mapId;
    const activeMap = missionMapId !== undefined ? this.maps.find((m) => m.mapId === missionMapId) : undefined;
    const missionPmapId = activeMap?.pmapId ?? this.pmapId;
    const missionUserPmapvId = activeMap?.userPmapvId ?? this.userPmapvId;

    if (!missionPmapId) {
      this.log.warn(
        `selectAreas requested but no pmapId configured for ${this.deviceName} — falling back to whole-home clean. ` +
          `Add the discovered pmapId/userPmapvId to your device config (or to the \`maps\` entry for multi-floor setups).`,
      );
      this.setCurrentArea(null);
      await this.connection.clean();
      return;
    }

    this.log.info(
      `Starting room-targeted clean on pmap ${missionPmapId} for ${regions.length} region(s): ` +
        `${regions.map((r) => r.region_id).join(', ')}`,
    );
    // Snapshot the mission baseline. We cycle currentArea using sqft cleaned
    // (preferred: pauses with the robot during recharge/stuck events) and fall
    // back to wall-clock elapsed when sqft isn't increasing.
    const startStatus = this.connection.getStatus();
    this.missionStartMs = Date.now();
    this.missionStartSqft = startStatus.missionSqft;
    this.missionMaxIndex = 0;
    this.setCurrentArea(this.selectedAreas[0]);
    // Seed PROG: first area Operating, rest Pending. Flushed to Matter in
    // one write so subscribers see the whole mission picture at mission start.
    this.initMissionProgress(this.selectedAreas);
    await this.connection.cleanRoom(missionPmapId, missionUserPmapvId, regions);
  }

  /**
   * While a multi-room mission is in progress, compute which area the robot is
   * likely cleaning right now and update `currentArea`. Prefers `sqft` progress
   * (Roomba's own cumulative-cleaned measure, pauses during recharge) over
   * wall-clock elapsed time. Fallback kicks in for firmware that doesn't emit
   * `sqft` or when sqft hasn't incremented yet.
   */
  private advanceCurrentAreaFromProgress(status: RoombaStatus): void {
    if (this.selectedAreas.length <= 1) return;

    const totalRooms = this.selectedAreas.length;
    let indexRaw: number;
    let signal: string;

    const sqftDelta = Math.max(0, status.missionSqft - (this.missionStartSqft ?? 0));
    if (sqftDelta > 0) {
      // sqft-driven: advance every `roomCleanSqft` of cleaned area.
      indexRaw = Math.floor(sqftDelta / this.roomCleanSqft);
      signal = `sqft=${sqftDelta.toFixed(0)} (threshold ${this.roomCleanSqft}/room)`;
    } else if (this.missionStartMs !== undefined) {
      // Time-driven fallback.
      const elapsedMs = Date.now() - this.missionStartMs;
      indexRaw = Math.floor(elapsedMs / this.roomCleanDurationMs);
      signal = `elapsed=${Math.round(elapsedMs / 60000)}min`;
    } else {
      return;
    }

    // Ratchet: never regress past the highest index we've reached this mission.
    // Skip commands (handled separately) bump missionMaxIndex directly; the
    // time-based estimate below it is just a safety net that catches up if no
    // skip was issued.
    const index = Math.min(Math.max(indexRaw, this.missionMaxIndex), totalRooms - 1);
    if (index > this.missionMaxIndex) this.missionMaxIndex = index;
    const targetArea = this.selectedAreas[index];
    if (targetArea !== this.lastPushed.currentArea) {
      this.log.info(
        `Advancing currentArea to ${targetArea} (room ${index + 1}/${totalRooms}, ${signal})`,
      );
      this.setCurrentArea(targetArea);
      // PROG: flip rooms before `targetArea` to Completed, `targetArea` to
      // Operating. Preserves any Skipped markers the app-skip handler set.
      this.advanceProgressTo(targetArea);
    }
  }

  /**
   * Push the `missionProgress` array to Matter's `ServiceArea.progress`
   * attribute. Swallows errors — on a matterbridge build that doesn't ship
   * the PROG feature-enabled behavior (our `RoombaVacuumCleaner` subclass
   * sets it, but older upstream builds didn't), the attribute doesn't exist
   * and the write is a silent no-op.
   */
  private flushProgress(): void {
    if (!this.endpointActive) return;
    try {
      const value = this.missionProgress.map((p) => ({
        areaId: p.areaId,
        status: p.status,
        totalOperationalTime: null,
        estimatedTime: null,
      }));
      this.device.setAttribute('serviceArea', 'progress', value, this.log);
      // Surface the current per-area status in the log so users can verify
      // PROG at a glance without having to read the attribute from HA's
      // developer tools. One-liner of "room N: Operating" etc.
      if (value.length > 0) {
        const statusName = (s: ServiceArea.OperationalStatus): string =>
          s === ServiceArea.OperationalStatus.Pending ? 'Pending'
            : s === ServiceArea.OperationalStatus.Operating ? 'Operating'
              : s === ServiceArea.OperationalStatus.Skipped ? 'Skipped'
                : 'Completed';
        this.log.info(
          `PROG: ${value.map((p) => `area ${p.areaId}=${statusName(p.status)}`).join(', ')}`,
        );
      }
    } catch (err) {
      this.log.debug(`setAttribute serviceArea.progress failed: ${err}`);
    }
  }

  /**
   * Initialize the progress array when a mission starts. Every selected area
   * gets `Pending` except the first, which is marked `Operating`.
   */
  private initMissionProgress(areaIds: readonly number[]): void {
    this.missionProgress = areaIds.map((areaId, i) => ({
      areaId,
      status: i === 0 ? ServiceArea.OperationalStatus.Operating : ServiceArea.OperationalStatus.Pending,
    }));
    this.flushProgress();
  }

  /**
   * Mark a specific area's progress state. Idempotent; no-op if the entry
   * already has the requested status.
   */
  private setAreaProgress(areaId: number, status: ServiceArea.OperationalStatus): void {
    const entry = this.missionProgress.find((p) => p.areaId === areaId);
    if (!entry) return;
    if (entry.status === status) return;
    entry.status = status;
    this.flushProgress();
  }

  /**
   * Advance progress markers to reflect a `currentArea` transition:
   *   - everything earlier in the selectedAreas list gets `Completed`
   *     (Option A semantics — we trust the sqft heuristic that advanced us)
   *   - the new current area gets `Operating`
   *   - anything after stays whatever it already was (usually Pending)
   */
  private advanceProgressTo(areaId: number): void {
    let changed = false;
    const targetIdx = this.selectedAreas.indexOf(areaId);
    if (targetIdx === -1) return;
    for (let i = 0; i < this.missionProgress.length; i++) {
      const entry = this.missionProgress[i];
      const entryIdx = this.selectedAreas.indexOf(entry.areaId);
      if (entryIdx === -1) continue;
      let desired = entry.status;
      if (entryIdx < targetIdx) {
        // Only mark Completed if not already terminal — preserves Skipped
        // states that the iRobot-app-skip handler may have set.
        if (entry.status === ServiceArea.OperationalStatus.Pending || entry.status === ServiceArea.OperationalStatus.Operating) {
          desired = ServiceArea.OperationalStatus.Completed;
        }
      } else if (entryIdx === targetIdx) {
        desired = ServiceArea.OperationalStatus.Operating;
      }
      if (desired !== entry.status) {
        entry.status = desired;
        changed = true;
      }
    }
    if (changed) this.flushProgress();
  }

  /**
   * Terminate the progress array at mission end. On a clean finish everything
   * that isn't already Skipped becomes Completed. On error, whatever was
   * Operating becomes Skipped (the mission ended before that area was done)
   * and any Pending entries stay Pending (per spec — "not yet started").
   */
  private finalizeMissionProgress(errored: boolean): void {
    if (this.missionProgress.length === 0) return;
    let changed = false;
    for (const entry of this.missionProgress) {
      if (errored) {
        if (entry.status === ServiceArea.OperationalStatus.Operating) {
          entry.status = ServiceArea.OperationalStatus.Skipped;
          changed = true;
        }
      } else {
        if (
          entry.status === ServiceArea.OperationalStatus.Operating ||
          entry.status === ServiceArea.OperationalStatus.Pending
        ) {
          entry.status = ServiceArea.OperationalStatus.Completed;
          changed = true;
        }
      }
    }
    if (changed) this.flushProgress();
    // Leave the array populated so the controller's UI keeps showing the
    // last mission's outcome until a new mission starts. Next selectAreas
    // will reinit.
  }

  /**
   * Write the ServiceArea.currentArea attribute. Guarded against errors because
   * some controllers don't include the attribute on all feature sets.
   */
  private setCurrentArea(areaId: number | null): void {
    if (!this.endpointActive) {
      this.lastPushed.currentArea = areaId;
      return;
    }
    if (areaId === this.lastPushed.currentArea) return;
    try {
      this.device.setAttribute('serviceArea', 'currentArea', areaId, this.log);
      this.lastPushed.currentArea = areaId;
    } catch (err) {
      this.log.debug(`Failed to set currentArea=${areaId}: ${err}`);
    }
  }

  private listenForStateUpdates(): void {
    this.connection.on('stateUpdate', (status: RoombaStatus) => {
      this.updateMatterState(status);
    });
    // User pressed "skip room" on the iRobot app — immediately advance currentArea
    // past the skipped region if it matches one we're tracking. This is the most
    // reliable real-time signal for per-region transitions; time-based cycling is
    // only a fallback when no skip is observed.
    this.connection.on('regionsSkipped', (skippedRegionIds: string[]) => {
      this.handleRegionsSkipped(skippedRegionIds);
    });
  }

  /**
   * When the iRobot app fires a skip for a region, advance `currentArea` to the
   * next selected area after the skipped one. If the skipped region isn't in
   * `selectedAreas` at all, it was an iRobot-app-initiated clean outside of
   * Matter's selection — leave state alone.
   */
  private handleRegionsSkipped(skippedRegionIds: string[]): void {
    if (this.selectedAreas.length <= 1) return;
    for (const regionId of skippedRegionIds) {
      const room = this.rooms.find((r) => r.regionId === regionId);
      if (!room) continue;
      const skippedIdx = this.selectedAreas.indexOf(room.areaId);
      if (skippedIdx === -1) continue;
      // Advance to the next selected area after the skipped one (clamped).
      const nextIdx = Math.min(skippedIdx + 1, this.selectedAreas.length - 1);
      // Bump the mission-max ratchet BEFORE writing currentArea so the time-based
      // advance on the same state-update cycle can't regress us back to the skipped
      // room a millisecond later.
      if (nextIdx > this.missionMaxIndex) this.missionMaxIndex = nextIdx;
      const nextArea = this.selectedAreas[nextIdx];
      // PROG: mark the skipped room explicitly before advancing to the next
      // one — otherwise `advanceProgressTo(nextArea)` would overwrite it to
      // Completed (the generic "we moved past this one" inference).
      this.setAreaProgress(room.areaId, ServiceArea.OperationalStatus.Skipped);
      if (nextArea !== this.lastPushed.currentArea) {
        this.log.info(
          `Region ${regionId} skipped; advancing currentArea to ${nextArea} (room ${nextIdx + 1}/${this.selectedAreas.length})`,
        );
        this.setCurrentArea(nextArea);
        this.advanceProgressTo(nextArea);
      }
    }
  }

  /**
   * Mark the underlying Matter endpoint as ready to accept attribute writes.
   * Should be called from the platform's onConfigure() once the server is online.
   */
  markActive(): void {
    this.endpointActive = true;
  }

  /**
   * Flip the `reachable` attribute on BridgedDeviceBasicInformation (bridged
   * mode only). In server mode the endpoint IS the root and has BasicInformation
   * instead — matter.js doesn't enable `reachable` on default BasicInformation,
   * so there's nothing we can write to. Apple Home infers offline state from
   * subscription timeouts instead, which works fine.
   *
   * Safe to call before `markActive()` — we skip the write silently in that
   * case, avoiding the "endpoint inactive" error spam.
   */
  setReachable(reachable: boolean): void {
    if (!this.endpointActive) return;
    // Server mode: bridgedDeviceBasicInformation doesn't exist on the endpoint;
    // writing would throw 'cluster not found'. No-op is the right answer — the
    // fabric layer handles offline detection.
    if (this.serverMode) return;
    try {
      this.device.setAttribute('bridgedDeviceBasicInformation', 'reachable', reachable, this.log);
    } catch (err) {
      this.log.debug(`setReachable(${reachable}) failed: ${err}`);
    }
  }

  /**
   * Cache of last-pushed attribute values so we only call setAttribute when something
   * actually changed. Roomba state messages arrive every ~2s during active cleaning,
   * and matterbridge logs every setAttribute — without a diff here, the log gets
   * spammed with "from X to X" noise.
   */
  private lastPushed: {
    runMode?: number;
    opState?: number;
    errorStateId?: number;
    batteryPct?: number;
    batChargeLevel?: number;
    batChargeState?: number;
    currentArea?: number | null;
  } = {};
  /** Tracks whether the robot was running on the previous state update so we can detect the running→idle transition. */
  private wasActive = false;
  /**
   * Mission-level state carried across state updates so we can synthesize a
   * single `OperationCompletion` event at the running→idle edge with the total
   * elapsed time. Matter 1.4 §7.5.7.2 — this event lets Apple Home (iOS 18.4+)
   * push a "cleaning finished" notification to the user's phone.
   */
  private missionActive = false;
  private missionStartTs = 0;
  private missionLastError = 0;
  /**
   * True once we've seen `tankLevel > 0` at least once — proves the robot has a
   * water tank installed. Without this, we'd spuriously report "Water Tank Empty"
   * for every vacuum-only model (whose tankLvl just never gets set).
   */
  private robotHasSeenTank = false;

  /**
   * Push current Roomba state to the Matter device attributes, skipping writes whose
   * value hasn't changed since the previous push.
   */
  updateMatterState(status: RoombaStatus): void {
    if (!this.endpointActive) return;
    try {
      const runMode = statusToRunMode(status);
      if (runMode !== this.lastPushed.runMode) {
        this.device.setAttribute('rvcRunMode', 'currentMode', runMode, this.log);
        this.lastPushed.runMode = runMode;
      }

      const opState = statusToOperationalState(status);
      if (opState !== this.lastPushed.opState) {
        this.device.setAttribute('rvcOperationalState', 'operationalState', opState, this.log);
        this.lastPushed.opState = opState;
      }

      // Roomba reports bin-full and tank-empty as separate booleans from the
      // numeric errorCode — fold both into the error struct so Apple Home / HA
      // can surface them via the standard RvcOperationalState error notification.
      const errorState = errorCodeToMatterError(status.errorCode, {
        binFull: status.binFull,
        // Only treat tankLvl=0 as "tank empty" on models that have a tank at all
        // (mop-equipped). tankLevel > 0 at least once in a mission proves it.
        tankEmpty: this.robotHasSeenTank && status.tankLevel === 0,
      });
      if (status.tankLevel > 0) this.robotHasSeenTank = true;
      if (errorState.errorStateId !== this.lastPushed.errorStateId) {
        this.device.setAttribute('rvcOperationalState', 'operationalError', errorState, this.log);
        // Also fire the Matter event so event-based subscribers (Apple Home
        // notifications, HA automations) get a push for the transition.
        if (errorState.errorStateId !== RvcOperationalState.ErrorState.NoError) {
          this.device
            .triggerEvent('rvcOperationalState', 'operationalError', errorState, this.log)
            .catch((err) => this.log.debug(`triggerEvent operationalError failed: ${err}`));
          this.log.info(
            `Robot error transition: id=${errorState.errorStateId} (Roomba errorCode=${status.errorCode}, binFull=${status.binFull}, tankLevel=${status.tankLevel})`,
          );
        }
        this.lastPushed.errorStateId = errorState.errorStateId;
      }

      // Matter spec: batPercentRemaining is 0-200, representing 0-100% in 0.5% steps
      const batteryPct = Math.min(status.batteryLevel * 2, 200);
      if (batteryPct !== this.lastPushed.batteryPct) {
        this.device.setAttribute('powerSource', 'batPercentRemaining', batteryPct, this.log);
        this.lastPushed.batteryPct = batteryPct;
      }

      const chargeLevel = batteryToChargeLevel(status.batteryLevel);
      if (chargeLevel !== this.lastPushed.batChargeLevel) {
        this.device.setAttribute('powerSource', 'batChargeLevel', chargeLevel, this.log);
        this.lastPushed.batChargeLevel = chargeLevel;
      }

      // Charge state: 0 = Unknown, 1 = IsCharging, 2 = IsAtFullCharge, 3 = IsNotCharging
      let chargeState = 3;
      if (status.charging) {
        chargeState = status.batteryLevel >= 100 ? 2 : 1;
      }
      if (chargeState !== this.lastPushed.batChargeState) {
        this.device.setAttribute('powerSource', 'batChargeState', chargeState, this.log);
        this.lastPushed.batChargeState = chargeState;
      }

      // ServiceArea.currentArea / selectedAreas lifecycle. ONLY act on the
      // running→idle transition, not on every poll while docked — otherwise we
      // race against Apple Home's `selectAreas` (which arrives before `changeToMode`
      // while the robot is still docked) and clear the selection out from under it,
      // causing the mission to fall back to a whole-home clean.
      const isActive = status.running || status.paused;

      // Mission lifecycle tracking — used for OperationCompletion event firing
      // at the running→idle transition. We want the ELAPSED time of the whole
      // mission, not just the current running stretch, so start the timer on
      // the first running edge and only reset at mission end.
      if (!this.missionActive && status.running) {
        this.missionActive = true;
        this.missionStartTs = Date.now();
        this.missionLastError = 0;
      }
      if (this.missionActive && status.errorCode !== 0) {
        // Latch any error we see during the mission — the final state might
        // clear errorCode to 0 before we emit the completion event, but users
        // still want to know "why" the mission ended.
        this.missionLastError = status.errorCode;
      }

      if (this.wasActive && !isActive) {
        // Fire the Matter OperationCompletion event with the total mission time
        // and the final error state. Apple Home (iOS 18.4+) consumes this to
        // push a "cleaning finished" notification. Fired exactly once per
        // mission, at the running→idle edge.
        if (this.missionActive) {
          const totalOperationalTime = Math.round((Date.now() - this.missionStartTs) / 1000);
          const completionErrorCode = errorCodeToMatterError(
            this.missionLastError,
            { binFull: status.binFull },
          ).errorStateId;
          this.device
            .triggerEvent(
              'rvcOperationalState',
              'operationCompletion',
              {
                completionErrorCode,
                totalOperationalTime,
                pausedTime: null,
              },
              this.log,
            )
            .catch((err) => this.log.debug(`triggerEvent operationCompletion failed: ${err}`));
          this.log.info(
            `Mission completed: errorCode=${completionErrorCode} totalOperationalTime=${totalOperationalTime}s`,
          );
          // PROG finalize: mark remaining Operating/Pending areas as Completed
          // (clean finish) or mark Operating → Skipped (error finish). Matches
          // Matter 1.4 §1.17.5.6 semantics — Pending stays Pending on error
          // because "not yet started".
          const errored = completionErrorCode !== RvcOperationalState.ErrorState.NoError;
          this.finalizeMissionProgress(errored);
          this.missionActive = false;
          this.missionLastError = 0;
        }

        if (this.lastPushed.currentArea !== null) {
          this.setCurrentArea(null);
        }
        // Don't clear `selectedAreas` on mission end — Apple Home re-sends
        // `selectAreas` before every subsequent mission so there's no risk of
        // stale selections carrying over. AND clearing triggers the iPhone
        // Home UI regression where empty SelectedAreas renders as "first room
        // ticked" instead of "all rooms". Leaving the attribute alone means
        // the room picker keeps displaying the user's last selection between
        // runs, which is also slightly better UX.
        this.missionStartMs = undefined;
        this.missionStartSqft = undefined;
      } else if (status.running && this.selectedAreas.length > 1) {
        // During an active multi-room mission, advance `currentArea` on each state
        // update so Apple Home's UI progresses from room to room instead of being
        // stuck on the first one. Driven by the robot's cumulative sqft cleaned
        // (or elapsed time when sqft isn't emitted).
        this.advanceCurrentAreaFromProgress(status);
      }
      this.wasActive = isActive;
    } catch (err) {
      this.log.debug(`Error updating Matter state: ${err}`);
    }
  }

  /**
   * Set initial device state on configure.
   */
  initializeState(): void {
    const status = this.connection.getStatus();
    this.updateMatterState(status);
  }
}

/**
 * Translate a Matter `RvcCleanMode` id to a Roomba cleaning preset. Returns
 * `null` for modes that don't correspond to a vacuum-power preset (e.g. Mop
 * modes — the Roomba picks suction automatically based on the installed tool).
 */
function matterModeToPreset(mode: number): 'auto' | 'quick' | 'max' | 'deep' | null {
  switch (mode) {
    case CLEAN_MODE_VACUUM:
      return 'auto';
    case CLEAN_MODE_QUICK:
      return 'quick';
    case CLEAN_MODE_MAX:
      return 'max';
    case CLEAN_MODE_DEEP_CLEAN:
      return 'deep';
    default:
      return null;
  }
}

/**
 * Roomba reports firmware versions like "lewis+3.20.13.57". Extract the numeric portion
 * and pack it into a 32-bit integer Matter can store (major*10000 + minor*100 + patch).
 */
function parseSoftwareVersion(ver: string): number {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(ver);
  if (!match) return 1;
  const [, major, minor, patch] = match;
  return Number(major) * 10000 + Number(minor) * 100 + Number(patch);
}

/**
 * Extract a numeric `hardwareVersion` from Roomba's hardware string. Matter
 * mandates this as a uint16 (spec §11.1.5.5 — max 65535), so we clamp
 * aggressively: Roomba SKUs like "j517020" would overflow if taken verbatim
 * (and a single set() with an oversized hardwareVersion rejects the entire
 * payload, silently undoing the BasicInformation override).
 *
 * Strategy: take the FIRST digit of the first letter-prefixed identifier
 * when we can (e.g. `j517020` → `5` for "j5 series"), otherwise clamp the
 * first digit run to 65535. Falls back to 1 when nothing parses.
 */
function parseHardwareVersion(ver: string): number {
  // Preferred: match a letter-prefixed SKU like `j5`, `s9`, `i7` → the digit.
  const skuMatch = /[a-zA-Z](\d)/.exec(ver);
  if (skuMatch) return Number(skuMatch[1]);
  const digitsMatch = /(\d+)/.exec(ver);
  if (!digitsMatch) return 1;
  return Math.min(Number(digitsMatch[1]), 65535);
}
