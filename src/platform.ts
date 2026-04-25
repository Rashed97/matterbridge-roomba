/**
 * Matterbridge platform for iRobot Roomba vacuum cleaners.
 */

import {
  MatterbridgeDynamicPlatform,
  type PlatformConfig,
  type PlatformMatterbridge,
} from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';
import { RoombaConnection, type DiscoveredMap, type RoombaDeviceConfig } from './roombaConnection.js';
import { RoombaDevice } from './roombaDevice.js';
import { getRoombaCloudCredentials, RoombaCloudError } from './roombaCloud.js';
import { discoverRoombas, type DiscoveredRobot } from './discovery.js';
import { toAreaId, withTimeout } from './utils.js';

interface RoomsInMissionPayload {
  pmapId: string;
  userPmapvId?: string;
  command?: string;
  selectAll: boolean;
  regions: Array<{ regionId: string; type: string; params?: Record<string, unknown> }>;
  newRegionIds: string[];
  time?: number;
}

interface CloudCredentials {
  /** iRobot account email. */
  email: string;
  /** iRobot account password (NOT the robot's local password). */
  password: string;
  /** Two-letter ISO country code; defaults to "US". */
  countryCode?: string;
}

interface RoombaPlatformConfig extends PlatformConfig {
  devices?: RoombaDeviceConfig[];
  /**
   * Optional cloud login. When set, any device whose `blid`/`password` are empty or
   * missing will have them auto-filled from the cloud account at startup.
   * Other device-level fields (ipAddress, rooms, pmapId, etc.) are left untouched.
   */
  cloud?: CloudCredentials;
  /**
   * Virtual boolean "buttons" — toggled on from the config UI, processed in
   * onConfigChanged, then reset to false and re-saved so they behave like one-shot
   * actions. We can't use rjsf action widgets because matterbridge's frontend uses
   * vanilla react-jsonschema-form which doesn't ship that widget.
   */
  testCloudLogin?: boolean;
  applyDiscoveredRooms?: boolean;
}

export class RoombaMatterbridgePlatform extends MatterbridgeDynamicPlatform {
  private readonly connections: Map<string, RoombaConnection> = new Map();
  private readonly roombaDevices: Map<string, RoombaDevice> = new Map();
  private readonly platformConfig: RoombaPlatformConfig;
  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private shuttingDown = false;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);
    this.platformConfig = config as RoombaPlatformConfig;
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`Starting Roomba plugin (reason: ${reason ?? 'unknown'})`);

    const devices = [...(this.platformConfig.devices ?? [])];
    if (devices.length === 0 && !this.platformConfig.cloud) {
      this.log.warn(
        'No Roomba devices configured. Add a device under "devices" or supply cloud credentials to auto-discover them.',
      );
      return;
    }

    // Resolve cloud-sourced credentials in place — fills blid/password/name/model for
    // devices where they're missing, and can auto-add all cloud robots if `devices` is empty.
    await this.resolveCloudCredentials(devices);

    // Auto-IP: broadcast-discover any Roombas on the LAN and fill in missing
    // `ipAddress` fields. Happens AFTER cloud onboarding so we can match on BLID
    // (which the cloud lookup resolves first) as well as on name.
    await this.resolveIpAddresses(devices);

    for (const deviceConfig of devices) {
      if (!deviceConfig.blid || !deviceConfig.password) {
        this.log.error(
          `Device "${deviceConfig.name ?? '(unnamed)'}" is missing blid/password and cloud lookup did not resolve them. Skipping.`,
        );
        continue;
      }
      if (!deviceConfig.ipAddress) {
        this.log.error(
          `Device "${deviceConfig.name ?? deviceConfig.blid}" has no ipAddress and LAN discovery didn't find it. ` +
            `Check that the robot is powered on and on the same subnet as Matterbridge (UDP/5678). ` +
            `As a fallback, set ipAddress manually in the config.`,
        );
        continue;
      }
      try {
        await this.setupDevice(deviceConfig);
      } catch (err) {
        this.log.error(`Failed to set up Roomba ${deviceConfig.blid}: ${err}`);
      }
    }
  }

  /**
   * Discovered robots from the startup LAN probe, keyed by BLID. Retained
   * so per-device setup can enrich `RoombaInfo.network.mac` from the probe
   * payload — j-series firmware doesn't publish `mac` on the MQTT state
   * stream, so the probe is the only reliable source pre-connect.
   */
  private discoveredRobotsByBlid: Map<string, DiscoveredRobot> = new Map();

  /**
   * Broadcast iRobot discovery probe on the LAN and cache the reply map.
   * Runs unconditionally at startup (not just when IPs are missing) so we
   * can harvest `mac` + `sku` metadata the MQTT state doesn't expose.
   *
   * - Fills missing `devices[].ipAddress` by matching on BLID (preferred)
   *   then `name`.
   * - Surfaces a warning when a configured IP differs from what the robot
   *   is currently announcing (DHCP-renumbered common cause of "suddenly
   *   offline").
   * - Silent when LAN discovery finds nothing AND nothing in config needed
   *   it (e.g. cross-subnet manual setup) — to avoid needless warnings.
   */
  private async resolveIpAddresses(devices: RoombaDeviceConfig[]): Promise<void> {
    const missing = devices.filter((d) => !d.ipAddress).length;

    this.log.info(
      `Broadcasting Roomba discovery on LAN (metadata harvest${missing ? ` + ${missing} missing ipAddress` : ''})…`,
    );
    let result;
    try {
      result = await discoverRoombas(3_000, this.log);
    } catch (err) {
      this.log.warn(`Roomba auto-discovery failed: ${err}`);
      return;
    }
    this.discoveredRobotsByBlid = result.byBlid;
    const foundCount = result.byBlid.size;
    if (foundCount === 0) {
      if (missing > 0) {
        this.log.warn(
          'Roomba auto-discovery returned no robots. ' +
            'Check that Matterbridge is on the same subnet as your Roomba(s) ' +
            '(UDP broadcast on port 5678 must reach them). ' +
            'Falling back to any manually-configured ipAddress values.',
        );
      }
      return;
    }

    for (const dev of devices) {
      const match: DiscoveredRobot | undefined =
        (dev.blid && result.byBlid.get(dev.blid)) ||
        (dev.name && result.byName.get(dev.name)) ||
        undefined;
      if (!match) continue;
      if (!dev.ipAddress) {
        dev.ipAddress = match.ipAddress;
        this.log.info(
          `Auto-discovered ipAddress=${match.ipAddress} for "${dev.name ?? match.robotname}" ` +
            `(blid=${match.blid}, sku=${match.sku || 'unknown'}, mac=${match.mac ?? '(not reported)'})`,
        );
      } else if (dev.ipAddress !== match.ipAddress) {
        this.log.warn(
          `Configured ipAddress (${dev.ipAddress}) for "${dev.name ?? match.robotname}" ` +
            `differs from the address the robot is currently announcing (${match.ipAddress}). ` +
            `If the robot is unreachable, update the config or remove ipAddress to auto-track DHCP changes.`,
        );
      }
    }
  }

  /**
   * If `cloud.email` + `cloud.password` are set, call the iRobot cloud API to fetch
   * all robots on the account. Any device in config that's missing blid/password has
   * those fields filled in from the cloud record with the matching name (or the sole
   * robot on a single-robot account). If `devices` is empty entirely, every cloud
   * robot is auto-added with a placeholder config (user still supplies ipAddress).
   *
   * Mutates `devices` in place.
   */
  private async resolveCloudCredentials(devices: RoombaDeviceConfig[]): Promise<void> {
    const cloud = this.platformConfig.cloud;
    if (!cloud?.email || !cloud?.password) return;

    const needsLookup = devices.some((d) => !d.blid || !d.password) || devices.length === 0;
    if (!needsLookup) return;

    this.log.info(`Fetching iRobot cloud credentials for ${cloud.email}…`);
    let cloudRobots;
    try {
      cloudRobots = await getRoombaCloudCredentials({
        email: cloud.email,
        password: cloud.password,
        countryCode: cloud.countryCode,
      });
    } catch (err) {
      if (err instanceof RoombaCloudError) {
        this.log.error(`iRobot cloud lookup failed (${err.kind}): ${err.message}`);
      } else {
        this.log.error(`iRobot cloud lookup failed: ${err}`);
      }
      return;
    }
    this.log.info(`Cloud returned ${cloudRobots.length} robot(s) on this account.`);

    // Auto-add robots that aren't in the devices list (by blid match on name).
    if (devices.length === 0) {
      for (const robot of cloudRobots) {
        this.log.warn(
          `Robot "${robot.name}" (blid ${robot.blid}) was auto-added from cloud. Set its ipAddress in the config before it can connect.`,
        );
        devices.push({
          name: robot.name,
          blid: robot.blid,
          password: robot.password,
          ipAddress: '',
          model: robot.sku,
          _resolvedFromCloud: true,
        });
      }
      return;
    }

    // Fill missing creds on existing device entries by matching on name (case-insensitive).
    for (const device of devices) {
      if (device.blid && device.password) continue;
      const match =
        cloudRobots.find((r) => r.name.toLowerCase() === (device.name ?? '').toLowerCase()) ??
        (cloudRobots.length === 1 ? cloudRobots[0] : undefined);
      if (!match) {
        this.log.warn(
          `Could not find a cloud robot matching "${device.name}". Known cloud robots: ${cloudRobots.map((r) => r.name).join(', ') || '(none)'}.`,
        );
        continue;
      }
      device.blid = device.blid || match.blid;
      device.password = device.password || match.password;
      if (!device.model) device.model = match.sku;
      device._resolvedFromCloud = true;
      this.log.info(`Resolved cloud credentials for "${device.name ?? match.name}" (blid ${match.blid}).`);
    }
  }

  private async setupDevice(deviceConfig: RoombaDeviceConfig): Promise<void> {
    const blid = deviceConfig.blid;
    this.log.info(`Setting up Roomba ${deviceConfig.name ?? blid}`);

    const connection = new RoombaConnection(deviceConfig, this.log);
    this.connections.set(blid, connection);

    // Connect first so we can classify the robot by SKU BEFORE building the Matter
    // device — supported clean modes depend on family (vacuum/swappable/combo/mop)
    // and Matter's SupportedModes list is fixed at endpoint construction.
    const vendorName = deviceConfig.vendor ?? 'iRobot';
    const FALLBACK_INFO = {
      name: deviceConfig.name ?? blid,
      sku: deviceConfig.model ?? 'Roomba',
      softwareVer: 'unknown',
      hardwareVer: 'unknown',
      network: {} as { mac?: string; ssid?: string; bssid?: string },
      capabilities: { multiPass: false, carpetBoost: false },
    };
    let family: 'vacuum' | 'swappable' | 'combo' | 'mop' | 'unknown' = 'unknown';
    let cleanCapabilities = { multiPass: false, carpetBoost: false };
    // Start with the fallback shape; overwritten after identity fetch succeeds.
    let identityInfo: typeof FALLBACK_INFO = FALLBACK_INFO;
    let identityApplied = false;
    try {
      await withTimeout(connection.connect(), 15_000, 'connect timeout');
      identityInfo = await withTimeout(connection.fetchIdentity(), 8_000, 'identity fetch timeout');
      family = connection.classifyFamily();
      cleanCapabilities = identityInfo.capabilities;

      // Enrich with the MAC from LAN discovery when the MQTT state didn't
      // publish it. j-series firmware omits the top-level `mac` field from
      // its state stream; the UDP discovery probe reply carries it reliably
      // across every generation.
      if (!identityInfo.network.mac) {
        const discovered = this.discoveredRobotsByBlid.get(blid);
        if (discovered?.mac) {
          identityInfo.network = { ...identityInfo.network, mac: discovered.mac };
          this.log.info(
            `[${deviceConfig.name ?? blid}] MAC ${discovered.mac} sourced from LAN discovery ` +
              `(MQTT state didn't publish \`mac\` — common on j-series firmware).`,
          );
        }
      }

      this.log.info(
        `[${deviceConfig.name ?? blid}] Classified as family "${family}" (sku=${identityInfo.sku}) ` +
          `capabilities: multiPass=${cleanCapabilities.multiPass} carpetBoost=${cleanCapabilities.carpetBoost}`,
      );
    } catch (err) {
      this.log.warn(
        `Could not pre-fetch identity for ${blid} (${err}); using config fallbacks — clean modes will default to vacuum-only.`,
      );
    }

    // Create the device with room definitions from config (empty array suppresses defaults).
    // Default to server mode ('server') — Apple Home / Google Home handle standalone RVC
    // better than bridged RVC. Users can set serverMode:false to fold it into the bridge.
    const serverMode = deviceConfig.serverMode ?? true;
    const roombaDevice = new RoombaDevice(
      connection,
      this.log,
      blid,
      deviceConfig.rooms,
      serverMode,
      deviceConfig.pmapId,
      deviceConfig.userPmapvId,
      deviceConfig.roomCleanDurationMinutes,
      deviceConfig.roomCleanSqft,
      family,
      deviceConfig.maps,
      cleanCapabilities,
      deviceConfig.iosAllRoomsWorkaround ?? true,
      deviceConfig.exposeRobotNetworkInfo ?? true,
      deviceConfig.overrideRobotNetworkInterfaces ?? false,
      deviceConfig.disableRootCustomizations ?? false,
    );
    this.roombaDevices.set(blid, roombaDevice);
    this.log.info(
      `[${deviceConfig.name ?? blid}] Exposing robot in ${serverMode ? 'server (standalone Matter device)' : 'bridged (under Matterbridge aggregator)'} mode`,
    );

    try {
      roombaDevice.applyIdentity(identityInfo, vendorName, deviceConfig.model);
      identityApplied = true;
    } catch (err) {
      this.log.warn(`applyIdentity failed: ${err}`);
    }
    void identityApplied;

    await this.registerDevice(roombaDevice.device);
    this.log.info(`Registered Roomba device: ${connection.getDeviceName()}`);

    // In server mode, matterbridge stamped its own version onto the root node. Overwrite
    // with the robot's real firmware now that the server is up.
    await roombaDevice.overrideRootNodeIdentity();

    // Set up reconnection handler + reachable flag tracking so the Matter
    // controller's "No Response" tile lights up when the robot drops off.
    connection.on('disconnected', () => {
      this.log.warn(`Roomba ${blid} disconnected, will attempt reconnection...`);
      roombaDevice.setReachable(false);
      this.scheduleReconnect(blid, deviceConfig);
    });

    // Discovery mode: log copy-paste-ready rooms config whenever a new region is seen.
    if (deviceConfig.discoverRooms) {
      const label = deviceConfig.name ?? blid;
      this.log.info(
        `[${label}] Room discovery mode is ON. ` +
          `Clean rooms ONE AT A TIME from the iRobot app — each mission will be logged ` +
          `with its region id and timestamp so you can tell which room is which.`,
      );
      connection.on('roomsInMission', (mission: RoomsInMissionPayload) => {
        this.logMission(label, mission);
      });
      connection.on('roomsDiscovered', (maps: DiscoveredMap[]) => {
        this.logDiscoveredRooms(label, maps);
      });
    }
  }

  /** Log a single mission as it arrives so users can correlate id -> physical room. */
  private logMission(deviceLabel: string, mission: RoomsInMissionPayload): void {
    const ids = mission.regions.map((r) => `${r.regionId}${r.type !== 'rid' ? `(${r.type})` : ''}`).join(', ');
    const newSuffix = mission.newRegionIds.length > 0 ? ` (NEW: ${mission.newRegionIds.join(', ')})` : '';
    const ts = mission.time ? new Date(mission.time * 1000).toLocaleTimeString() : 'unknown';
    this.log.info(
      `[${deviceLabel}] Mission "${mission.command ?? 'start'}" at ${ts}: ` +
        `${mission.selectAll ? 'whole home' : `regions=[${ids}]`}${newSuffix}. ` +
        `(If you just cleaned a single room in the iRobot app, region ${ids} = that room.)`,
    );
  }

  /**
   * Pretty-print the accumulated room discoveries in a form the user can drop straight
   * into the plugin config under `rooms`. Named regions keep type `rid`; everything else
   * is labelled a placeholder so the user knows to rename it.
   */
  private logDiscoveredRooms(deviceLabel: string, maps: DiscoveredMap[]): void {
    for (const map of maps) {
      const lines: string[] = [];
      lines.push(
        `[${deviceLabel}] Discovered ${map.regions.length} room(s) on map ${map.pmapId}. ` +
          `Paste the block below into this device's config (under "devices[].") and rename each room:`,
      );
      lines.push(`  "pmapId": ${JSON.stringify(map.pmapId)},`);
      if (map.userPmapvId) {
        lines.push(`  "userPmapvId": ${JSON.stringify(map.userPmapvId)},`);
      }
      lines.push(`  "rooms": [`);
      map.regions.forEach((region, i) => {
        const comma = i === map.regions.length - 1 ? '' : ',';
        const areaId = toAreaId(region.regionId);
        lines.push(
          `    { "areaId": ${areaId}, "regionId": ${JSON.stringify(region.regionId)}, ` +
            `"regionType": ${JSON.stringify(region.type)}, ` +
            `"name": "Room ${region.regionId} (rename me)", "type": null }${comma}`,
        );
      });
      lines.push(`  ]`);
      this.log.info(lines.join('\n'));
    }
  }

  override async onConfigure(): Promise<void> {
    this.log.info('Configuring Roomba devices...');

    // Mark devices active so state can be pushed to Matter attributes.
    // Connection may already have been established during onStart for identity pre-fetch;
    // if so, we just reuse it. Otherwise, attempt to (re)connect.
    for (const [blid, connection] of this.connections) {
      try {
        if (!connection.isConnected()) {
          await connection.connect();
        }
        const device = this.roombaDevices.get(blid);
        if (device) {
          device.markActive();
          device.initializeState();
          device.setReachable(true);
        }
        this.log.info(`Roomba ${blid} connected and configured`);
      } catch (err) {
        this.log.error(`Failed to connect to Roomba ${blid}: ${err}`);
        const config = this.platformConfig.devices?.find((d) => d.blid === blid);
        if (config) {
          this.scheduleReconnect(blid, config);
        }
      }
    }
  }

  /**
   * Invoked by matterbridge when the user clicks Confirm in the config UI.
   * We use it to implement one-shot "action toggles": a boolean field in the
   * schema, when flipped true, triggers an action here and is then reset to
   * false and re-saved so it behaves like a push-button.
   */
  override async onConfigChanged(config: PlatformConfig): Promise<void> {
    this.log.debug('Config changed; checking for pending one-shot actions…');
    const next = config as RoombaPlatformConfig;
    // Sync the in-memory config so subsequent operations see fresh values.
    Object.assign(this.platformConfig, next);

    let dirty = false;
    if (next.testCloudLogin) {
      await this.runTestCloudLogin();
      next.testCloudLogin = false;
      this.platformConfig.testCloudLogin = false;
      dirty = true;
    }
    if (next.applyDiscoveredRooms) {
      await this.runApplyDiscoveredRooms();
      next.applyDiscoveredRooms = false;
      this.platformConfig.applyDiscoveredRooms = false;
      dirty = true;
    }
    if (dirty) {
      try {
        this.saveConfig(this.platformConfig);
      } catch (err) {
        this.log.warn(`Failed to re-save config after action: ${err}`);
      }
    }
  }

  /** Hit the cloud API with the configured credentials and log what we find. */
  private async runTestCloudLogin(): Promise<void> {
    const cloud = this.platformConfig.cloud;
    if (!cloud?.email || !cloud?.password) {
      this.log.error('Test cloud login: no cloud.email/cloud.password set.');
      return;
    }
    try {
      const robots = await getRoombaCloudCredentials({
        email: cloud.email,
        password: cloud.password,
        countryCode: cloud.countryCode,
      });
      if (robots.length === 0) {
        this.log.warn('Cloud login OK, but the account has no paired robots.');
        return;
      }
      this.log.info(`Cloud login OK. ${robots.length} robot(s) found:`);
      for (const r of robots) {
        this.log.info(`  - ${r.name}: blid=${r.blid} sku=${r.sku} softwareVer=${r.softwareVer}`);
      }
    } catch (err) {
      if (err instanceof RoombaCloudError) {
        this.log.error(`Cloud login failed (${err.kind}): ${err.message}`);
      } else {
        this.log.error(`Cloud login failed: ${err}`);
      }
    }
  }

  /**
   * Pull currently-accumulated room discoveries out of each connection's in-memory
   * cache, merge them into the device configs (preserving user-renamed rooms), and
   * persist via `saveConfig`. The user then only needs to rename the rooms they
   * care about — nothing else to edit.
   */
  private async runApplyDiscoveredRooms(): Promise<void> {
    const devices = this.platformConfig.devices ?? [];
    if (devices.length === 0) {
      this.log.warn('Apply discovered rooms: no devices configured.');
      return;
    }

    let updatedAny = false;
    for (const deviceConfig of devices) {
      const connection = this.connections.get(deviceConfig.blid);
      if (!connection) continue;
      const discovered = connection.getDiscoveredMaps();
      if (discovered.length === 0) {
        this.log.info(
          `[${deviceConfig.name ?? deviceConfig.blid}] No rooms discovered yet. ` +
            `Turn on discoverRooms, clean each room once from the iRobot app (per floor if multi-floor), then click this again.`,
        );
        continue;
      }

      const deviceLabel = deviceConfig.name ?? deviceConfig.blid;
      if (discovered.length === 1) {
        // Single-map case: use the top-level `pmapId`/`userPmapvId` and keep the
        // config shape simple. Preserve any previously user-renamed room names.
        const only = discovered[0];
        deviceConfig.pmapId = only.pmapId;
        if (only.userPmapvId) deviceConfig.userPmapvId = only.userPmapvId;
        // Explicit single-map mode: clear any `maps` array left over from an
        // earlier multi-map discovery.
        deviceConfig.maps = [];

        const existingByAreaId = new Map((deviceConfig.rooms ?? []).map((r) => [r.areaId, r]));
        deviceConfig.rooms = only.regions.map((region) => {
          const areaId = toAreaId(region.regionId);
          const existing = existingByAreaId.get(areaId);
          return {
            areaId,
            regionId: region.regionId,
            regionType: region.type,
            name: existing?.name ?? `Room ${region.regionId}`,
            type: existing?.type,
            floor: existing?.floor,
          };
        });
        updatedAny = true;
        this.log.info(
          `[${deviceLabel}] Saved ${deviceConfig.rooms.length} room(s) from pmap ${only.pmapId}. ` +
            `Rename them in the config UI, then restart the plugin.`,
        );
        continue;
      }

      // Multi-map case: build a `maps[]` array and tag each room with its owning
      // mapId. Preserve existing `maps` entries (to keep user-chosen names + ids)
      // by matching on `pmapId`; assign fresh mapIds to any newly-seen pmaps.
      const existingMapByPmap = new Map((deviceConfig.maps ?? []).map((m) => [m.pmapId, m]));
      const usedMapIds = new Set(
        (deviceConfig.maps ?? []).map((m) => m.mapId).filter((id): id is number => typeof id === 'number'),
      );
      const nextMapId = (): number => {
        let id = 1;
        while (usedMapIds.has(id)) id++;
        usedMapIds.add(id);
        return id;
      };

      const newMaps = discovered.map((disc, idx) => {
        const existing = existingMapByPmap.get(disc.pmapId);
        const mapId = existing?.mapId ?? nextMapId();
        return {
          mapId,
          name: existing?.name ?? `Map ${idx + 1}`,
          pmapId: disc.pmapId,
          userPmapvId: disc.userPmapvId,
        };
      });
      const pmapToMatterMapId = new Map(newMaps.map((m) => [m.pmapId, m.mapId]));

      const existingByAreaId = new Map((deviceConfig.rooms ?? []).map((r) => [r.areaId, r]));
      const newRooms: typeof deviceConfig.rooms = [];
      for (const disc of discovered) {
        const matterMapId = pmapToMatterMapId.get(disc.pmapId);
        for (const region of disc.regions) {
          const areaId = toAreaId(region.regionId);
          const existing = existingByAreaId.get(areaId);
          newRooms.push({
            areaId,
            regionId: region.regionId,
            regionType: region.type,
            name: existing?.name ?? `Room ${region.regionId}`,
            type: existing?.type,
            floor: existing?.floor,
            mapId: existing?.mapId ?? matterMapId,
          });
        }
      }

      deviceConfig.maps = newMaps;
      deviceConfig.rooms = newRooms;
      // Top-level pmapId is unused in multi-map mode — clear for clarity.
      // (If user reverts to a single floor later, discovery will rewrite this.)
      delete deviceConfig.pmapId;
      delete deviceConfig.userPmapvId;
      updatedAny = true;
      this.log.info(
        `[${deviceLabel}] Saved ${newRooms.length} room(s) across ${newMaps.length} map(s): ` +
          newMaps.map((m) => `${m.name} (pmap ${m.pmapId})`).join(', ') +
          '. Rename maps and rooms in the config UI, then restart the plugin.',
      );
    }

    if (updatedAny) {
      try {
        this.saveConfig(this.platformConfig);
        this.log.info('Config saved. Restart the plugin for room changes to take effect.');
      } catch (err) {
        this.log.error(`Failed to save config: ${err}`);
      }
    }
  }

  override async onShutdown(reason?: string): Promise<void> {
    this.log.info(`Shutting down Roomba plugin (reason: ${reason ?? 'unknown'})`);
    this.shuttingDown = true;

    // Clear all reconnect timers
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();

    // Disconnect all robots
    for (const [blid, connection] of this.connections) {
      this.log.info(`Disconnecting Roomba ${blid}`);
      connection.disconnect();
    }
    this.connections.clear();
    this.roombaDevices.clear();
  }

  private scheduleReconnect(blid: string, config: RoombaDeviceConfig): void {
    if (this.shuttingDown) return;
    // Don't schedule if already pending
    if (this.reconnectTimers.has(blid)) return;

    // Exponential backoff: 30s, 60s, 120s, 240s, capped at 600s
    const attempts = (this.reconnectAttempts.get(blid) ?? 0) + 1;
    this.reconnectAttempts.set(blid, attempts);
    const delayMs = Math.min(30_000 * 2 ** (attempts - 1), 600_000);
    this.log.info(`Scheduling reconnect #${attempts} for Roomba ${blid} in ${Math.round(delayMs / 1000)}s`);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(blid);
      if (this.shuttingDown) return;
      this.log.info(`Attempting to reconnect to Roomba ${blid}...`);

      const connection = this.connections.get(blid);
      if (connection) {
        try {
          await connection.connect();
          const device = this.roombaDevices.get(blid);
          if (device) {
            // markActive is idempotent. Call it here too because onConfigure's initial
            // connect may have failed (robot offline during plugin restart), leaving
            // endpointActive=false. Without this, every updateMatterState after a
            // recovery reconnect is a silent no-op and Apple Home keeps showing the
            // stale initial values.
            device.markActive();
            device.initializeState();
            device.setReachable(true);
          }
          this.reconnectAttempts.delete(blid);
          this.log.info(`Reconnected to Roomba ${blid}`);
        } catch (err) {
          this.log.warn(`Reconnect failed for ${blid}: ${err}`);
          this.scheduleReconnect(blid, config);
        }
      }
    }, delayMs);

    this.reconnectTimers.set(blid, timer);
  }
}

