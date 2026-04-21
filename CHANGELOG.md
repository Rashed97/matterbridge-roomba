# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0] — 2026-04-20

Focused release on controller metadata correctness + per-room progress.

### Added

- **Auto-IP via LAN discovery.** The plugin now broadcasts a UDP/5678
  `irobotmcs` probe at startup and fills in each `devices[].ipAddress` from the
  matching reply. Works on every Roomba generation (600 / 700 / 900 / i / j /
  s / Braava m). `ipAddress` is now optional in config — set it only when
  broadcast-discovery can't reach the robot (docker bridge networking, VLAN
  without broadcast forwarding). A warning is logged if DHCP has moved the
  robot vs the configured value.
- **ServiceArea `ProgressReporting` (PROG) feature.** Matter 1.4 §1.17.4.2
  per-area progress tracking is now enabled on the cluster server. During a
  multi-room mission the plugin writes a `Progress[]` attribute with
  `{areaId, status}` entries that flip Pending → Operating → Completed as the
  sqft-heuristic advances `currentArea`. `Skipped` is marked when the user
  taps Skip in the iRobot app. On mission-end, remaining Operating/Pending
  areas become Completed (clean finish) or Operating → Skipped on error.
- **Vacuum-accurate `BasicInformation` on root node.** `partNumber`,
  `productLabel`, and `serialNumber` are now populated from the robot's SKU
  and BLID respectively — Google Home and HA's "Matter Info" pane show these
  in the device details where they previously displayed "Unknown".
- **`NetworkCommissioning(WiFi)` behavior on root node.** Attached after
  server-node creation, populated with the **Roomba's own SSID**
  (`wlcfg.ssid` from the robot's MQTT state, not the Matterbridge host's
  network). Flips HA's "Network type" display from "Ethernet" to "Wi-Fi" and
  surfaces the vacuum's SSID in the Matter Info pane.
- **Pre-run mop/water guard.** When entering Mop or VacuumThenMop mode, the
  plugin now validates `padFaulted` / tank presence / tank level BEFORE
  dispatching the clean command. A doomed mission is rejected up front with
  the appropriate Matter `OperationalError`
  (MopCleaningPadMissing / WaterTankMissing / WaterTankEmpty, §7.4.7.1
  ErrorState 68-71) rather than the robot starting and error-ing out mid-run.
- **`interruptOnMidMissionSelectAreas` config surface** (default `true`).
  Reserved for v1.7.1 — the schema lands in 1.7.0 so upgraders don't have to
  re-edit when the mid-mission `selectAreas` handling actually ships.
- **Type definitions for robot Wi-Fi state fields** (`wlcfg`, `netinfo`,
  `wifistat`, `mac`, `country`) in `src/dorita980.d.ts`, so future features
  that want to surface robot network info have types to lean on.

### Changed

- `RoombaInfo` now includes a `network: { mac?, ssid?, bssid? }` block sourced
  from the robot's own MQTT state. Plugin authors forking the code can use
  these to populate additional Matter attributes.
- Subclassed `RoboticVacuumCleaner` → `RoombaVacuumCleaner` locally to enable
  the ServiceArea PROG feature at construction time. Matterbridge's default
  `createDefaultServiceAreaClusterServer` registers the behavior with only the
  `Maps` feature; we override the method in the subclass to add
  `ProgressReporting` too. No upstream matterbridge patch needed.

### Documentation

- README "Limitations we've chosen not to fix" section: MAC-address in
  `GeneralDiagnostics.NetworkInterfaces` always shows the host's (with a
  pointer to the override approach); BridgedDeviceBasicInformation
  StartUp/ShutDown events not wired for `serverMode: false` users.
- Highlights list updated with auto-IP, PROG, metadata accuracy entries.
- Quick-start config example now omits `ipAddress`.

## [1.6.0] — 2026-04-20

First public npm release. Consolidates everything since 1.5.0 (never published):
capability-aware clean modes, completion events, and the iOS Home "All Rooms"
workaround.

### Added

- **Capability-gated `RvcCleanMode`**. The plugin now reads Roomba's reported
  `cap.multiPass`, `cap.carpetBoost`, `cap.pp`, and `cap.floorTypeDetect` fields
  and only exposes the clean modes a given robot actually supports. A 600/i3+
  no longer sees a non-functional Deep Clean option; a j5+ gets Vacuum + Quick +
  Max + Deep Clean; a Combo model gets Vacuum + Mop + Vacuum-then-Mop. Swappable
  models (j5/j6) toggle Mop vs Vacuum based on which reservoir is installed.
- **`Quick` and `Max` clean modes** on vacuum-capable robots that support them —
  mapped to `setCleaningPassesOne` + carpet-boost-eco and
  `setCleaningPassesTwo` + carpet-boost-performance respectively.
- **`OperationCompletion` events** (`RvcOperationalState`). Fires on every
  running-to-idle transition with `totalOperationalTime` and `completionErrorCode`
  so controllers can push notifications for "Roomba finished cleaning".
- **`ReachableChanged` events** (`BridgedDeviceBasicInformation`). The plugin
  now updates `reachable` on MQTT connect/disconnect, so controllers show the
  right online/offline state when a robot goes dark.
- **`iosAllRoomsWorkaround` config option** (default on). Works around an iOS
  Home UI bug where picking "All Rooms" leaves the picker checkboxes showing only
  the first room. When enabled, the plugin mirrors the full room list back to
  `SelectedAreas` so iOS Home's summary display matches intent within a few
  seconds. Technically violates Matter spec §1.17.6.4 (attribute-via-command-only);
  set to `false` to return to spec-compliant behavior.

### Fixed

- **Stale error on `OperationCompletion`**. The plugin now latches the last
  non-zero error code during a mission so it survives Roomba's
  clear-error-on-dock behavior and is reported accurately on completion.
- **iOS Home "All Rooms" picker reset**. Previously the picker summary briefly
  showed "1 Room" and sometimes stuck there; now resolves to "All Rooms" once
  the subscription update lands (full fix requires the iOS side; see known
  limitations in README.md).

## [1.4.0] — 2026-04-20

### Added

- **Multi-floor home support** via the `ServiceArea` cluster's `Maps` feature
  (Matter 1.4 §17.7). Each persistent map on the robot becomes a `SupportedMap`
  entry; rooms are grouped under the right floor in Apple Home / Google Home.
- **`maps[]` config array** for multi-pmap setups, and a `mapId` field on each
  room entry to associate it with a map. Single-map setups continue to work
  with the top-level `pmapId` / `userPmapvId` fields.
- **Multi-map discovery**. `applyDiscoveredRooms` now detects 2+ distinct
  pmaps and writes the `maps[]` array automatically, preserving any renamed
  entries from previous runs.

### Fixed

- Multi-map discovery previously saved only the primary pmap; all discovered
  maps are now preserved.

## [1.3.0] — 2026-04-20

### Added

- **Model-aware `RvcCleanMode`**. SKU classification (j5/j6 swappable,
  j7+/j9+ combo, m-series mop-only, older vacuum-only) drives which clean modes
  appear in the Matter controller.
- **Mop mode** on swappable models with runtime gating based on which reservoir
  is installed — picking Mop while the bin is in raises an error.
- **Vacuum-then-Mop mode** on Combo models, routed through Roomba's native
  combo behavior.

## [1.2.0] — 2026-04-20

### Added

- **Full Matter 1.4 RVC error enum coverage**: Stuck, WheelsJammed, BrushJammed,
  NavigationSensorObscured, CannotReachTargetArea, BinMissing, BinFull,
  WaterTankMissing, WaterTankEmpty, WaterTankLidOpen, MopCleaningPadMissing,
  FailedToFindChargingDock, low-battery — all mapped from Roomba error codes.
- **`OperationalError` events** fire on transitions into error states so
  controllers can push-notify. No event spam on clear-to-zero transitions.
- **`Mapping` run mode** routed to Roomba's `train()` mission so training
  runs are triggerable from the Matter controller.

## [1.1.2] — 2026-04-20

### Added

- **Multi-room progress tracking**. `currentArea` auto-advances across rooms
  during a multi-room mission using a cumulative-sqft heuristic, with
  wall-clock time as fallback. Tuned by `roomCleanSqft` and
  `roomCleanDurationMinutes` config keys.
- **Skip detection** from the iRobot app. Pressing Skip advances the Matter
  controller's "currently cleaning" indicator within ~1 second.

## [1.1.1] — 2026-04-20

### Fixed

- **Dock-loop bug**. "Send to Dock" previously left Roomba in a paused mission,
  which caused the robot to re-undock after the controller's subsequent
  refresh. The plugin now sends `stop()` before `dock()` to cancel any paused
  state.
- Various operational-state edge cases around pause/resume and charging.

## [1.1.0] — 2026-04-19

### Added

- **Room-targeted cleans** via `ServiceArea.SelectAreas`. Apple Home / Google
  Home room selection is translated to Roomba's `cleanRoom` command with pmap
  + region IDs resolved from config.
- **Cloud-assisted onboarding**. Enter your iRobot account email/password in
  config and the plugin auto-fetches each robot's BLID and local MQTT password
  at startup via the Gigya federated login.
- **Frontend actions**: `testCloudLogin` and `applyDiscoveredRooms` toggles
  exposed in the Matterbridge UI for one-click ops.
- **Room discovery mode**. Toggle `discoverRooms: true` on a device and the
  plugin captures room/region IDs from the robot's own clean commands, ready
  for `applyDiscoveredRooms` to snapshot into config.
- **CI workflow** (GitHub Actions) building against Node 18/20/22/24.

## [1.0.2] — 2026-04-19

### Added

- **Standalone server mode per robot** (`serverMode: true`, default). Each
  robot gets its own Matter server node and QR code, avoiding Apple Home's
  bridged-RVC-device quirks.

### Fixed

- Root-node identity now uses the robot's own vendor/product info instead of
  inheriting Matterbridge's.

## [1.0.1] — 2026-04-18

### Fixed

- Device registration timing and initial state update race conditions.
- `BasicInformation` metadata correctness (vendor, model, firmware).

## [1.0.0] — 2026-03-24

Initial implementation. Exposes a single Roomba as a Matter RVC device with
basic clean / pause / resume / dock commands and operational-state mapping.

[1.7.0]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.7.0
[1.6.0]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.6.0
[1.4.0]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.4.0
[1.3.0]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.3.0
[1.2.0]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.2.0
[1.1.2]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.1.2
[1.1.1]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.1.1
[1.1.0]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.1.0
[1.0.2]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.0.2
[1.0.1]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.0.1
[1.0.0]: https://github.com/Rashed97/matterbridge-roomba/releases/tag/v1.0.0
