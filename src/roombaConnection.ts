/**
 * Roomba connection manager using dorita980 for local MQTT communication.
 */

import { Local, type RobotState } from 'dorita980';
import { EventEmitter } from 'events';
import type { AnsiLogger } from 'matterbridge/logger';

const ROBOT_CIPHERS = ['AES128-SHA256', 'TLS_AES_256_GCM_SHA384'];
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Decode the Roomba's hex-encoded SSID (firmware reports UTF-8 bytes as a
 * hex string, no length prefix). Returns the decoded text, or the original
 * input when it doesn't look like a valid hex pair-string.
 */
function decodeRoombaSsid(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) return raw;
  try {
    const decoded = Buffer.from(raw, 'hex').toString('utf8');
    // Guard against all-zero / non-printable payloads. Keep the raw string
    // if the decoded value contains control characters — Matter would
    // reject those anyway.
    if (!/^[\x20-\x7E\u00A0-\uFFFF]+$/.test(decoded)) return raw;
    return decoded;
  } catch {
    return raw;
  }
}

export interface RoombaRoomConfig {
  /** Matter area ID (uint32). Must be unique per device. Presented to controllers. */
  areaId: number;
  /**
   * Roomba's internal region identifier, as reported by the robot in
   * `lastCommand.regions[*].region_id`. Required for room-targeted cleans to work —
   * the plugin translates the Matter areaId back to this string before sending the
   * `cleanRoom` command. If omitted, room-targeted cleans for this area fall back
   * to a whole-home clean.
   */
  regionId?: string;
  /**
   * Region type for the robot: `"rid"` for rooms (default), `"zid"` for zones.
   * Pulled from `lastCommand.regions[*].type` during discovery.
   */
  regionType?: string;
  /** User-facing room name shown in the Matter controller. */
  name: string;
  /**
   * Optional Matter AreaNamespace tag (from matterbridge/matter/tags),
   * e.g. "LivingRoom", "Kitchen", "Bedroom".
   */
  type?: string;
  /** Optional floor number (defaults to 0). */
  floor?: number;
  /**
   * Matter map id this room belongs to — must match a `mapId` in the device's
   * `maps` array. If omitted and `maps` is configured, falls back to the first
   * map. If `maps` is empty/unset, ignored.
   */
  mapId?: number;
}

/**
 * A Roomba persistent map. Multi-map / multi-floor homes (j7+, j9+, s9+) have
 * distinct pmaps per floor; configure one entry per floor and each room points
 * at its owning map by `mapId`.
 */
export interface RoombaMapConfig {
  /** Matter map identifier (uint32). Must be unique within this device. */
  mapId: number;
  /** Human-readable label the Matter controller displays (e.g. "Main Floor"). */
  name: string;
  /**
   * Persistent map id this Matter map represents. Used when dispatching room
   * cleans — overrides the device-level `pmapId` for rooms on this map.
   */
  pmapId: string;
  /** User map version id that pairs with this `pmapId`. */
  userPmapvId?: string;
}

export interface RoombaDeviceConfig {
  name?: string;
  blid: string;
  password: string;
  ipAddress: string;
  refreshInterval?: number;
  idleRefreshInterval?: number;
  /** Marker set during platform startup when this device's creds came from cloud lookup. */
  _resolvedFromCloud?: boolean;
  /** Model name override for the Matter BasicInformation cluster (e.g. "Roomba j5+"). */
  model?: string;
  /** Vendor name override (default "iRobot"). */
  vendor?: string;
  /**
   * Expose the robot as its OWN independent Matter server node (own QR code, own pairing)
   * instead of a bridged endpoint under the Matterbridge aggregator.
   *
   * Default: `true`. Recommended for Apple Home and Google Home — both controllers
   * handle standalone RVC devices better than bridged ones (bridged mode causes metadata
   * to appear as "Matterbridge/Aggregator" and creates a ghost "unsupported device" in
   * single-device bridges).
   *
   * Set to `false` if you prefer a single pairing code for all Matterbridge plugins;
   * be aware that Apple Home may display the vacuum metadata incorrectly in that mode.
   */
  serverMode?: boolean;
  /** Optional list of rooms to expose as Matter service areas. */
  rooms?: RoombaRoomConfig[];
  /**
   * Optional list of maps. Provide one entry per pmap when a j-series or
   * s-series Roomba has Imprint Smart Maps for multiple floors. Each room's
   * `mapId` picks which map it lives on. If unset, the device is treated as
   * single-map and the top-level `pmapId` / `userPmapvId` apply to every room.
   */
  maps?: RoombaMapConfig[];
  /**
   * Persistent map identifier for this robot's active map (`pmap_id` from the
   * robot's `lastCommand`). Required for room-targeted cleans. Auto-captured in
   * discovery mode; user pastes into config alongside `rooms`.
   */
  pmapId?: string;
  /**
   * User's version identifier for the active map (`user_pmapv_id`). Required by
   * the `cleanRoom` command alongside `pmapId`. Auto-captured in discovery mode.
   */
  userPmapvId?: string;
  /**
   * When true, every time the robot reports a room-based clean command, the plugin
   * logs a copy-paste-ready JSON snippet with the captured region IDs. Turn on,
   * clean each room once from the iRobot app, copy the snippet into `rooms`,
   * turn this off.
   */
  discoverRooms?: boolean;
  /**
   * Estimated minutes per room. Fallback signal for advancing
   * `ServiceArea.currentArea` during a multi-room clean, used when the robot
   * isn't reporting `cleanMissionStatus.sqft` (rare on j5+/j7/j9/i/s models).
   * Default 10.
   */
  roomCleanDurationMinutes?: number;
  /**
   * Estimated square feet the robot cleans per room before the controller UI
   * advances to the next selected room. This is the PRIMARY signal (pauses
   * during recharge/stuck events, unlike wall-clock time). Default 75 sqft
   * (about 7 m²). Tune down for studio-sized rooms, up for open-plan spaces.
   */
  roomCleanSqft?: number;
  /**
   * Dev-only: dump every raw MQTT state delta to the log. Use to discover robot
   * state fields the plugin doesn't yet parse.
   */
  verboseState?: boolean;
  /**
   * Populate `NetworkCommissioning` cluster + `GeneralDiagnostics.NetworkInterfaces`
   * on the Matter root node with the VACUUM'S own Wi-Fi info (SSID, MAC, Type=WiFi)
   * instead of leaving matter.js's auto-populated host-NIC defaults in place.
   *
   * Default: `true`. Set to `false` if your Matter controller (notably
   * Apple Home on some iOS versions) gets stuck in "Updating…" after the
   * plugin is updated — Apple's Home hub is spec-strict and may not tolerate
   * the NetworkCommissioning cluster being added post-commissioning without
   * re-pairing. Turning this off reverts to the pre-v1.7 display (Network
   * type: Ethernet, MAC: bridge host's, SSID: blank) but keeps the rest of
   * the plugin working.
   *
   * After flipping this, remove + re-pair the accessory from the affected
   * controller for the change to take effect cleanly.
   */
  exposeRobotNetworkInfo?: boolean;

  /**
   * Override `GeneralDiagnostics.NetworkInterfaces` on the root endpoint
   * with a synthetic entry carrying the Roomba's own MAC + type=WiFi
   * (instead of the Matterbridge host's real NIC info that matter.js
   * auto-populates). Default: **false**.
   *
   * The Matter spec (§11.11.6.7) defines `NetworkInterfaces` as
   * diagnostic-only — it's supposed to reflect the adapters the device
   * itself actually sees — and faking it with another device's MAC has
   * caused Apple Home (iOS) to enter a "Updating…" loop after network
   * transitions (WiFi off/on, leaving home and returning). The theory
   * is that iOS Home uses the MAC + empty-IP-lists combination as a
   * reachability-integrity check and gets confused when the MAC doesn't
   * match anything routable from its local subnet.
   *
   * With this set to `false` (default) HA's "Matter Info" shows the
   * Matterbridge host's MAC instead of the Roomba's — which is less
   * intuitive but spec-compliant and doesn't upset iOS Home. The SSID
   * still displays correctly (that's via the separate
   * `NetworkCommissioning` cluster, which is read-only and safe).
   *
   * Turn this on only to experiment with showing the Roomba's MAC. You'll
   * need to re-pair the accessory from any Apple devices after toggling,
   * and watch for regression across network transitions.
   */
  overrideRobotNetworkInterfaces?: boolean;

  /**
   * Master kill-switch: when true, the plugin skips ALL v1.7.0+ root-node
   * customizations — no `BasicInformation` overrides (vendor/product/
   * version/partNumber/productLabel/serialNumber stay at matterbridge's
   * defaults), no `NetworkCommissioning` attach (no SSID display), no
   * `GeneralDiagnostics` override. Endpoint-level features (RVC clusters,
   * ServiceArea PROG, etc.) are unaffected.
   *
   * Use this to bisect Apple Home connectivity issues: if iOS Home is
   * stable with this true and broken with this false, the regression is
   * caused by one of the root-level schema enhancements. Re-enable
   * components one at a time (clear this flag, then toggle
   * `exposeRobotNetworkInfo`/`overrideRobotNetworkInterfaces`) to find
   * the exact culprit.
   *
   * Default: false. This is a debug aid — leave it off in normal use.
   */
  disableRootCustomizations?: boolean;

  /**
   * When a `selectAreas` command lands during an active mission, stop the
   * current mission and immediately re-issue a `cleanRoom` with the new area
   * list. Default: true (Option A semantics — matches iOS/macOS Home's
   * expectation that the selection change takes effect immediately).
   *
   * Set to false to reject mid-mission changes with `InvalidInMode` instead —
   * the user must pause/stop the current clean and re-select. Honest and
   * spec-compliant (see Matter 1.4 §1.17.7.1 status codes), but requires a
   * manual extra step from the user.
   *
   * Reserved for v1.7.1 — config surface lands in 1.7.0 so upgraders don't
   * have to re-edit when the behavior ships.
   */
  interruptOnMidMissionSelectAreas?: boolean;

  /**
   * Work around iOS Home's room-picker UI regression where picking "All Rooms"
   * (which Matter represents as `selectAreas([])`, an unconstrained mission)
   * leaves the picker checkboxes displaying only the first configured room.
   *
   * When enabled (default), the plugin echoes the FULL list of configured
   * areaIds back to the `SelectedAreas` attribute whenever the controller
   * sends an empty `selectAreas` command — so iOS Home's summary flip to
   * "All Rooms" after a few seconds. macOS Home handles the empty-list
   * semantic correctly and doesn't need this.
   *
   * This mildly violates Matter spec §1.17.6.4 ("SelectedAreas shall NOT be
   * updated outside of processing a SelectAreas command") — the two
   * representations are functionally identical for a Roomba, but a strict
   * controller could theoretically differentiate them. Disable this once
   * Apple ships a fix in iOS Home.
   */
  iosAllRoomsWorkaround?: boolean;
}

export interface DiscoveredRegion {
  regionId: string;
  type: string;
  /** First time we saw this region (ms since epoch). */
  firstSeen: number;
}

export interface DiscoveredMap {
  pmapId: string;
  userPmapvId?: string;
  regions: DiscoveredRegion[];
}

export interface RoombaInfo {
  name: string;
  sku: string;
  softwareVer: string;
  hardwareVer: string;
  /**
   * Network identity reported by the ROBOT ITSELF over MQTT. Lets the plugin
   * populate Matter's `NetworkCommissioning.Networks[]` with the vacuum's
   * actual Wi-Fi — which is what HA / Google Home display under "Matter Info"
   * — instead of the Matterbridge host's network (the default matter.js
   * picks when no NetworkCommissioning cluster is present).
   *
   * All fields are optional: older firmware occasionally omits `wlcfg`
   * / `netinfo` blocks entirely, and the type shim falls through to undefined
   * rather than erroring.
   */
  network: {
    /** Vacuum's MAC (colon-separated hex). Falls back to undefined if absent. */
    mac?: string;
    /** Wi-Fi SSID the vacuum is associated with. */
    ssid?: string;
    /** AP BSSID the vacuum is connected to. */
    bssid?: string;
  };
  /**
   * Capability flags the robot broadcasts over MQTT. We read a handful of fields
   * to decide which Matter clean modes to advertise — older models (i3+/i4+,
   * 600/700 series) don't support multi-pass or carpet boost, so offering
   * Quick/DeepClean on those is just lying to the controller.
   *
   * Field semantics, reverse-engineered across dorita980 / NickWaterton /
   * iRobot community threads:
   *   - multiPass: 0 = unsupported, >=1 = supports single/two-pass selection
   *   - carpetBoost: 0 = unsupported, >=1 = supports Eco/Auto/Performance
   *   - pp (power pass): Roomba's internal boost-on-carpet-auto toggle
   *   - eco: supports eco cleaning profile
   *   - edge: supports edge-clean toggle
   */
  capabilities: {
    multiPass: boolean;
    carpetBoost: boolean;
  };
}

/**
 * Robot hardware family classification, derived at startup from `sku`.
 * Drives which Matter `RvcCleanMode` options the plugin advertises.
 */
export type RoombaFamily =
  /** Vacuum-only (900, i1-i4, older). */
  | 'vacuum'
  /** Swappable: ships with a bin; owner can physically swap in a mop reservoir
   *  (j5, j6, some i7s). Mop and Vacuum modes are mutually exclusive at any moment. */
  | 'swappable'
  /** Combo: integrated bin+tank, auto-switches per surface (j7 Combo, j9 Combo). */
  | 'combo'
  /** Mop-only (Braava m6, m8). */
  | 'mop'
  /** Unknown SKU — default to vacuum-only to avoid surfacing a mop option that doesn't work. */
  | 'unknown';

/**
 * Snapshot of the currently-installed cleaning tool, derived from MQTT state.
 * Used alongside `RoombaFamily` to decide which modes are currently *available*
 * (vs. theoretically supported) on swappable models.
 */
export interface RoombaInstalledTool {
  /** Dust bin is physically installed and ready to collect debris. */
  binInstalled: boolean;
  /** Water tank / mop reservoir is installed. */
  mopInstalled: boolean;
  /**
   * Combo-only: `detectedPad === "invalid"` or any pad error state.
   * Controllers should treat mop modes as blocked when this is true.
   */
  padFaulted: boolean;
}

export interface RoombaStatus {
  running: boolean;
  charging: boolean;
  docking: boolean;
  paused: boolean;
  stuck: boolean;
  batteryLevel: number;
  binFull: boolean;
  tankLevel: number;
  phase: string;
  errorCode: number;
  cycle: string;
  name: string;
  /** Cumulative square feet cleaned this mission (from cleanMissionStatus.sqft). */
  missionSqft: number;
  /** Mission elapsed minutes (from cleanMissionStatus.mssnM). */
  missionElapsedMin: number;
  /** Historical average mission length in minutes (from bbmssn.aMssnM). 0 if unknown. */
  avgMissionMin: number;
  /** Live-state tool detection used to gate Vacuum vs Mop clean modes. */
  installedTool: RoombaInstalledTool;
}

export class RoombaConnection extends EventEmitter {
  private robot: Local | null = null;
  private cipherIndex = 0;
  private connected = false;
  private connecting = false;
  private disconnectEmitted = false;
  private latestState: RobotState = {};
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly activeRefreshMs: number;
  private readonly idleRefreshMs: number;
  /** Accumulated map of pmap_id -> discovered rooms, populated while `discoverRooms` is on. */
  private readonly discoveredMaps = new Map<string, DiscoveredMap>();

  constructor(
    private readonly config: RoombaDeviceConfig,
    private readonly log: AnsiLogger,
  ) {
    super();
    this.activeRefreshMs = (config.refreshInterval ?? 10) * 1000;
    this.idleRefreshMs = (config.idleRefreshInterval ?? 120) * 1000;
  }

  async connect(): Promise<void> {
    if (this.connected || this.connecting) return;
    this.connecting = true;

    try {
      for (let attempt = 0; attempt < ROBOT_CIPHERS.length; attempt++) {
        const cipher = ROBOT_CIPHERS[this.cipherIndex];
        this.log.debug(`Connecting to Roomba ${this.config.blid} at ${this.config.ipAddress} (cipher: ${cipher})`);

        try {
          await this.attemptConnect(cipher);
          this.log.info(`Connected to Roomba ${this.config.blid}`);
          this.disconnectEmitted = false;
          return;
        } catch (err) {
          this.log.warn(`Connection failed with cipher ${cipher}: ${err}`);
          this.teardownRobot();
          this.cipherIndex = (this.cipherIndex + 1) % ROBOT_CIPHERS.length;
        }
      }

      throw new Error(`Failed to connect to Roomba ${this.config.blid} after trying all ciphers`);
    } finally {
      this.connecting = false;
    }
  }

  private attemptConnect(cipher: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Connection timed out'));
      }, CONNECT_TIMEOUT_MS);

      try {
        this.robot = new Local(this.config.blid, this.config.password, this.config.ipAddress, 2, {
          ciphers: cipher,
        });

        this.robot.on('connect', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.connected = true;
          this.startPolling();
          resolve();
        });

        this.robot.on('state', (state: RobotState) => {
          this.mergeState(state);
          if (this.config.verboseState) this.logStateDelta(state);
          this.emit('stateUpdate', this.getStatus());
        });

        this.robot.on('close', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error('Connection closed before established'));
            return;
          }
          this.handleDisconnect('close');
        });

        this.robot.on('offline', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error('Robot offline during connect'));
            return;
          }
          this.log.warn(`Roomba ${this.config.blid} went offline`);
          this.handleDisconnect('offline');
        });

        this.robot.on('error', (...args: unknown[]) => {
          const err = args[0] instanceof Error ? args[0] : new Error(String(args[0]));
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(err);
          }
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  private handleDisconnect(reason: string): void {
    this.connected = false;
    this.stopPolling();
    this.teardownRobot();
    if (!this.disconnectEmitted) {
      this.disconnectEmitted = true;
      this.log.debug(`Roomba ${this.config.blid} disconnect emitted (reason: ${reason})`);
      this.emit('disconnected');
    }
  }

  private teardownRobot(): void {
    if (!this.robot) return;
    try {
      this.robot.removeAllListeners();
    } catch {
      // ignore
    }
    try {
      this.robot.end();
    } catch {
      // ignore
    }
    this.robot = null;
  }

  private mergeState(state: RobotState): void {
    Object.assign(this.latestState, state);
    this.captureDiscovery(state);
    this.captureSkipCommand(state);
  }

  private lastSeenCommandTime: number | undefined;
  /** Tracks the most recent skip command we emitted, so we don't re-emit on state heartbeats. */
  private lastSkipCommandTime: number | undefined;

  /**
   * Detect when the user (or anyone) pressed the "skip room" button on the iRobot
   * app. This is the ONE real-time per-region signal Roomba firmware exposes —
   * `sqft`/`mssnM` stay at 0 on j5+/j7+ so time-based cycling is the only
   * automatic fallback, but skips let us advance currentArea precisely when a
   * human actually moves the robot past a room.
   */
  private captureSkipCommand(state: RobotState): void {
    const lc = state.lastCommand;
    if (!lc || lc.command !== 'skip') return;
    if (!Array.isArray(lc.regions) || lc.regions.length === 0) return;
    // lastCommand.time is a seconds-since-epoch timestamp of when the command ran.
    // Use it to dedup across repeated state heartbeats that echo the same command.
    if (lc.time === this.lastSkipCommandTime) return;
    this.lastSkipCommandTime = lc.time;
    this.emit(
      'regionsSkipped',
      lc.regions.map((r) => r.region_id),
    );
  }

  /**
   * If a `lastCommand` with regions has just arrived, merge its regions into the discovered
   * map set and emit a `roomsDiscovered` event with the accumulated catalog.
   * Also emits a per-mission `roomsInMission` event describing what was in the command
   * we just observed — handy for correlating region IDs with the room you pressed
   * "Clean" on in the iRobot app.
   */
  private captureDiscovery(state: RobotState): void {
    const lc = state.lastCommand;
    if (!lc || !lc.pmap_id || !Array.isArray(lc.regions) || lc.regions.length === 0) return;

    // Only fire once per distinct mission (lastCommand.time is the mission timestamp).
    if (lc.time && lc.time === this.lastSeenCommandTime) return;
    this.lastSeenCommandTime = lc.time;

    const existing = this.discoveredMaps.get(lc.pmap_id) ?? {
      pmapId: lc.pmap_id,
      userPmapvId: lc.user_pmapv_id,
      regions: [],
    };
    if (lc.user_pmapv_id) existing.userPmapvId = lc.user_pmapv_id;

    const newRegionIds: string[] = [];
    for (const region of lc.regions) {
      if (!region || !region.region_id) continue;
      if (existing.regions.some((r) => r.regionId === region.region_id)) continue;
      existing.regions.push({
        regionId: region.region_id,
        type: region.type ?? 'rid',
        firstSeen: Date.now(),
      });
      newRegionIds.push(region.region_id);
    }
    this.discoveredMaps.set(lc.pmap_id, existing);

    // Per-mission event: tell listeners what was in THIS command (regardless of
    // whether it's new or a repeat). This is what makes "clean one room, see its id"
    // work as an identification strategy.
    this.emit('roomsInMission', {
      pmapId: lc.pmap_id,
      userPmapvId: lc.user_pmapv_id,
      command: lc.command,
      selectAll: lc.select_all ?? false,
      regions: lc.regions.map((r) => ({
        regionId: r.region_id,
        type: r.type ?? 'rid',
        params: r.params,
      })),
      newRegionIds,
      time: lc.time,
    });

    if (newRegionIds.length > 0) {
      this.emit('roomsDiscovered', Array.from(this.discoveredMaps.values()));
    }
  }

  /** Returns the current discovery catalog (may be empty). */
  getDiscoveredMaps(): DiscoveredMap[] {
    return Array.from(this.discoveredMaps.values());
  }

  /** Signature of the last mission/command/pose/bbmssn slice we logged, for dedup. */
  private lastVerboseSignatures: { mission?: string; lastCommand?: string; pose?: string; bbmssn?: string } = {};

  /**
   * Emit compact one-line log entries for the bits of robot state we care about,
   * but ONLY when they've changed since the last log. Robot sends heartbeat state
   * messages every ~2s; without this dedup the log gets spammed with identical lines.
   */
  private logStateDelta(state: RobotState): void {
    if (state.cleanMissionStatus) {
      const cms = state.cleanMissionStatus as typeof state.cleanMissionStatus & { sqft?: number };
      const sig = `${cms.cycle}|${cms.phase}|${cms.mssnM}|${cms.sqft ?? ''}|${cms.error}|${cms.nMssn}|${cms.notReady}`;
      if (sig !== this.lastVerboseSignatures.mission) {
        this.lastVerboseSignatures.mission = sig;
        this.log.info(
          `[mission] cycle=${cms.cycle} phase=${cms.phase} mssnM=${cms.mssnM} ` +
            `sqft=${cms.sqft ?? '-'} err=${cms.error} nMssn=${cms.nMssn} notReady=${cms.notReady}`,
        );
      }
    }
    const lc = state.lastCommand;
    if (lc) {
      const regionList = lc.regions?.map((r) => r.region_id).join(',') ?? '-';
      const sig = `${lc.command}|${lc.initiator}|${lc.time}|${lc.pmap_id ?? ''}|${regionList}|${lc.ordered}`;
      if (sig !== this.lastVerboseSignatures.lastCommand) {
        this.lastVerboseSignatures.lastCommand = sig;
        this.log.info(
          `[lastCommand] command=${lc.command} initiator=${lc.initiator} time=${lc.time} ` +
            `pmap_id=${lc.pmap_id ?? '-'} regions=[${regionList}] ordered=${lc.ordered}`,
        );
      }
    }
    const pose = (state as { pose?: { point?: { x: number; y: number }; theta?: number } }).pose;
    if (pose?.point) {
      // Round pose to integer so every millimetre of robot movement doesn't spam the log.
      const sig = `${Math.round(pose.point.x)}|${Math.round(pose.point.y)}|${Math.round(pose.theta ?? 0)}`;
      if (sig !== this.lastVerboseSignatures.pose) {
        this.lastVerboseSignatures.pose = sig;
        this.log.info(`[pose] x=${pose.point.x} y=${pose.point.y} theta=${pose.theta}`);
      }
    }
    const bb = (state as { bbmssn?: { aMssnM?: number; nMssnC?: number } }).bbmssn;
    if (bb?.aMssnM !== undefined) {
      const sig = `${bb.aMssnM}|${bb.nMssnC}`;
      if (sig !== this.lastVerboseSignatures.bbmssn) {
        this.lastVerboseSignatures.bbmssn = sig;
        this.log.info(`[bbmssn] aMssnM=${bb.aMssnM} nMssnC=${bb.nMssnC}`);
      }
    }
    // Capabilities + installed-tool fields. Only log once per connection when
    // they appear; they're static per robot/tool-swap and noisy otherwise.
    const capFields: Array<[string, unknown]> = [
      ['sku', (state as { sku?: string }).sku],
      ['cap', (state as { cap?: unknown }).cap],
      ['tankLvl', (state as { tankLvl?: number }).tankLvl],
      ['bin', (state as { bin?: unknown }).bin],
      ['mopReady', (state as { mopReady?: unknown }).mopReady],
      ['detectedPad', (state as { detectedPad?: unknown }).detectedPad],
      ['padWetness', (state as { padWetness?: unknown }).padWetness],
      ['subModSwVer', (state as { subModSwVer?: unknown }).subModSwVer],
      ['mac', (state as { mac?: unknown }).mac],
      ['wlcfg', (state as { wlcfg?: unknown }).wlcfg],
      ['netinfo', (state as { netinfo?: unknown }).netinfo],
      ['wifistat', (state as { wifistat?: unknown }).wifistat],
    ];
    for (const [name, val] of capFields) {
      if (val === undefined) continue;
      const sigKey = `cap:${name}`;
      const sig = JSON.stringify(val);
      if (sig !== (this.lastVerboseSignatures as Record<string, string>)[sigKey]) {
        (this.lastVerboseSignatures as Record<string, string>)[sigKey] = sig;
        this.log.info(`[${name}] ${sig}`);
      }
    }
  }

  getInfo(): RoombaInfo {
    const s = this.latestState;
    const cap = (s as { cap?: Record<string, unknown> }).cap ?? {};
    const asNum = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const sku = (s.sku as string | undefined) ?? this.config.model ?? 'Roomba';
    // j-series firmware doesn't populate `hardwareVer` in the MQTT state
    // stream. Rather than show "unknown" in HA's Matter Info pane, derive a
    // meaningful value from the SKU + bootloader rev (subModSwVer.mobBtl).
    // Falls back to the SKU alone when bootloader info is missing.
    const bootloader = (s.subModSwVer as { mobBtl?: string } | undefined)?.mobBtl;
    const rawHwVer = s.hardwareVer as string | undefined;
    const hardwareVer = rawHwVer && rawHwVer !== 'unknown'
      ? rawHwVer
      : bootloader
        ? `${sku} (bootloader ${bootloader})`
        : sku;
    return {
      name: s.name ?? this.config.name ?? `Roomba ${this.config.blid}`,
      sku,
      softwareVer: (s.softwareVer as string | undefined) ?? 'unknown',
      hardwareVer,
      network: {
        mac: s.mac,
        // Roomba firmware reports SSID as a hex-encoded string (e.g.
        // `426C756520526162626974` for "Blue Rabbit") — straight ASCII bytes,
        // no length prefix, no UTF-8 surprises we've ever seen. Decode here
        // so Matter sees the human-readable name. Fall back to the raw value
        // if decoding fails (non-hex, odd length, etc.).
        ssid: decodeRoombaSsid(s.wlcfg?.ssid),
        bssid: s.netinfo?.bssid,
      },
      capabilities: {
        multiPass: asNum(cap.multiPass) >= 1,
        // Carpet-boost / power-pass indicator varies across firmware generations:
        //   - 980 / i7 era exposed `cap.carpetBoost` explicitly.
        //   - 980 also uses `cap.pp` (power-pass) for the same thing.
        //   - j-series drops the explicit flag but publishes
        //     `cap.floorTypeDetect` (the sensor that drives auto-boost), which
        //     any robot with carpet-boost support also has.
        // Accept any of the three so we don't under-report Max/DeepClean on
        // newer models that implicitly support them.
        carpetBoost:
          asNum(cap.carpetBoost) >= 1 ||
          asNum(cap.pp) >= 1 ||
          asNum(cap.floorTypeDetect) >= 1,
      },
    };
  }

  /**
   * Classify the robot into a cleaning-mode family based on its SKU. This drives
   * which Matter `RvcCleanMode` options the plugin advertises at startup.
   *
   * Roomba SKUs follow the pattern `<letter><digits><modifiers>`:
   *   - j5*, j6*, i7+ (pre-Combo): bin standard, mop reservoir is a sold-separately swap.
   *   - j7/j9 with "Combo" marker: integrated bin+tank, auto-switches per surface.
   *   - m6, m8 (Braava): mop-only.
   *   - i1-i4, 600/700/800/900 series, s9: vacuum-only.
   *
   * The Combo identifier isn't in SKU — iRobot uses model suffixes like "J7 Combo".
   * The cloud API returns distinct SKUs for Combo units (e.g. `j755040`) but the
   * difference from a non-Combo `j755020` isn't published. Fall back to checking
   * whether live state ever reports `tankLvl` or `mopReady` — if yes, treat as combo.
   */
  classifyFamily(): RoombaFamily {
    const sku = (this.latestState.sku ?? this.config.model ?? '').toString();
    const head = sku.slice(0, 1).toLowerCase();

    if (head === 'm') return 'mop';

    // Combo detection: live state has revealed tank/mop fields → treat as combo.
    // This covers j7/j9 Combo, s9+ Combo, and future combo units regardless of SKU.
    if (this.latestState.tankLvl !== undefined || this.latestState.mopReady !== undefined) {
      return 'combo';
    }

    // j/i series: swappable models ship with a swappable bin + optional mop cartridge.
    // j1-j6 pre-Combo are classic swappable; j7/j9 non-Combo are rare but possible.
    if ((head === 'j' || head === 'i') && /^[ji][1-6]/.test(sku)) {
      return 'swappable';
    }

    // Older vacuum-only models (600-900) and s-series, plus i1-i4.
    if (head === 's' || /^\d{3}/.test(sku) || (head === 'i' && /^i[1-4]/.test(sku))) {
      return 'vacuum';
    }

    // Newer j7/j9 default to combo-ish to surface options; runtime gating still
    // applies. Unknown SKUs fall back to vacuum-only to avoid false mop promises.
    if (head === 'j') return 'combo';
    return 'unknown';
  }

  /**
   * Read current tool installation from MQTT state. Used to gate which modes
   * are *currently* available on swappable models (owner physically swapped to
   * the mop reservoir) and to detect pad faults on combo units.
   */
  getInstalledTool(): RoombaInstalledTool {
    const s = this.latestState;
    const binInstalled = s.bin?.present !== false; // missing field defaults to "present"
    const mopInstalled =
      (typeof s.tankLvl === 'number' && s.tankLvl >= 0 && s.bin?.present === false) ||
      s.mopReady?.tankPresent === true ||
      (s.detectedPad !== undefined && s.detectedPad !== 'invalid');
    const padFaulted = s.detectedPad === 'invalid';
    return { binInstalled, mopInstalled, padFaulted };
  }

  getStatus(): RoombaStatus {
    const s = this.latestState;
    const phase = s.cleanMissionStatus?.phase ?? 'charge';
    const cycle = s.cleanMissionStatus?.cycle ?? 'none';
    const errorCode = s.cleanMissionStatus?.error ?? 0;

    const running = phase === 'run';
    const charging = phase === 'charge' || phase === 'recharge';
    const docking = phase === 'hmUsrDock' || phase === 'hmMidMsn' || phase === 'hmPostMsn';
    const paused = !running && cycle === 'clean' && phase === 'stop';
    const stuck = phase === 'stuck';

    return {
      running,
      charging,
      docking,
      paused,
      stuck,
      batteryLevel: s.batPct ?? 0,
      binFull: s.bin?.full ?? false,
      tankLevel: s.tankLvl ?? 0,
      phase,
      errorCode,
      cycle,
      name: s.name ?? this.config.name ?? `Roomba ${this.config.blid}`,
      missionSqft: s.cleanMissionStatus?.sqft ?? 0,
      missionElapsedMin: s.cleanMissionStatus?.mssnM ?? 0,
      avgMissionMin: s.bbmssn?.aMssnM ?? 0,
      installedTool: this.getInstalledTool(),
    };
  }

  private startPolling(): void {
    this.stopPolling();
    const status = this.getStatus();
    const interval = status.running || status.docking ? this.activeRefreshMs : this.idleRefreshMs;
    this.refreshTimer = setInterval(() => {
      this.refreshState();
    }, interval);
  }

  private stopPolling(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async refreshState(): Promise<void> {
    if (!this.robot || !this.connected) return;
    try {
      const state = await this.robot.getRobotState(['batPct', 'bin', 'cleanMissionStatus', 'tankLvl']);
      this.mergeState(state);
      this.emit('stateUpdate', this.getStatus());

      // Adjust polling rate based on activity
      const status = this.getStatus();
      const desiredInterval = status.running || status.docking ? this.activeRefreshMs : this.idleRefreshMs;
      if (this.refreshTimer) {
        this.stopPolling();
        this.refreshTimer = setInterval(() => this.refreshState(), desiredInterval);
      }
    } catch (err) {
      this.log.debug(`Failed to refresh state for ${this.config.blid}: ${err}`);
    }
  }

  /**
   * Wait briefly for at least one MQTT state message from the robot, then return whatever
   * identifying fields we've accumulated. Unlike `getRobotState`, this does NOT block until
   * every requested field has been seen — some fields (e.g. `hardwareVer`) may never arrive
   * from newer models, so we take a best-effort snapshot instead.
   *
   * Also proactively requests `wlcfg` + `netinfo` (the vacuum's own Wi-Fi
   * config) via dorita980's `getWirelessConfig()` — these are NOT in the
   * default state stream, so without an explicit fetch `info.network.ssid`
   * stays undefined and the Matter `NetworkCommissioning` wiring falls back
   * to the host's network.
   */
  async fetchIdentity(timeoutMs = 5_000): Promise<RoombaInfo> {
    if (!this.connected) {
      throw new Error('Not connected');
    }
    if (!this.latestState.sku && !this.latestState.softwareVer) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        const once = () => {
          clearTimeout(timer);
          resolve();
        };
        this.once('stateUpdate', once);
      });
    }

    // Explicitly request the wireless config block. This is a separate MQTT
    // preferences request and may take a second or two — time-box so we don't
    // hold up startup if the robot is slow to respond, and swallow errors
    // (older Roombas without the API just fall back to undefined SSID).
    if (!this.latestState.wlcfg && this.robot) {
      try {
        const wireless = await Promise.race([
          this.robot.getWirelessConfig(),
          new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('wireless-config timeout')), 4_000)),
        ]);
        this.mergeState(wireless);
      } catch (err) {
        this.log.debug(`getWirelessConfig failed: ${err}`);
      }
    }

    return this.getInfo();
  }

  async clean(): Promise<void> {
    if (!this.robot) throw new Error('Not connected');
    await this.robot.clean();
  }

  /** Start a mapping / training run (Roomba explores and refines its pmap). */
  async train(): Promise<void> {
    if (!this.robot) throw new Error('Not connected');
    await this.robot.train();
  }

  /**
   * Apply a pair of cleaning-power preferences (carpet boost + passes). Used
   * when the controller picks a `RvcCleanMode` like Auto / Quick / Max /
   * DeepClean — each of these presets corresponds to a specific combination.
   * The robot stores these persistently; subsequent `clean()`/`cleanRoom()`
   * commands use whatever preset was last applied.
   */
  async applyCleaningPreset(
    preset: 'auto' | 'quick' | 'max' | 'deep',
  ): Promise<void> {
    if (!this.robot) throw new Error('Not connected');
    switch (preset) {
      case 'auto':
        await this.robot.setCarpetBoostAuto();
        await this.robot.setCleaningPassesAuto();
        return;
      case 'quick':
        // Eco carpet boost + single pass = fast, quiet, light clean.
        await this.robot.setCarpetBoostEco();
        await this.robot.setCleaningPassesOne();
        return;
      case 'max':
        // Performance boost + auto passes = high suction, smart pass count.
        await this.robot.setCarpetBoostPerformance();
        await this.robot.setCleaningPassesAuto();
        return;
      case 'deep':
        // Performance boost + two passes = thorough double-cover.
        await this.robot.setCarpetBoostPerformance();
        await this.robot.setCleaningPassesTwo();
        return;
    }
  }

  /**
   * Start a room-targeted clean. `regions` must contain one or more
   * `{ region_id, type }` pairs — the robot rejects the command if any region is
   * not present in its active pmap. `pmapId` + `userPmapvId` identify which map
   * version those regions belong to.
   */
  async cleanRoom(
    pmapId: string,
    userPmapvId: string | undefined,
    regions: Array<{ region_id: string; type: string }>,
  ): Promise<void> {
    if (!this.robot) throw new Error('Not connected');
    if (regions.length === 0) {
      throw new Error('cleanRoom called with no regions; falling back to full clean is the caller\u2019s responsibility');
    }
    await this.robot.cleanRoom({
      ordered: 1,
      pmap_id: pmapId,
      user_pmapv_id: userPmapvId,
      regions,
    });
  }

  async pause(): Promise<void> {
    if (!this.robot) throw new Error('Not connected');
    await this.robot.pause();
  }

  async resume(): Promise<void> {
    if (!this.robot) throw new Error('Not connected');
    await this.robot.resume();
  }

  async stop(): Promise<void> {
    if (!this.robot) throw new Error('Not connected');
    await this.robot.stop();
  }

  async dock(): Promise<void> {
    if (!this.robot) throw new Error('Not connected');
    await this.robot.dock();
  }

  async find(): Promise<void> {
    if (!this.robot) throw new Error('Not connected');
    await this.robot.find();
  }

  disconnect(): void {
    this.stopPolling();
    this.teardownRobot();
    this.connected = false;
    // Intentionally do not emit 'disconnected' on explicit disconnect.
    this.disconnectEmitted = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getBlid(): string {
    return this.config.blid;
  }

  getDeviceName(): string {
    return this.config.name ?? `Roomba ${this.config.blid}`;
  }
}
