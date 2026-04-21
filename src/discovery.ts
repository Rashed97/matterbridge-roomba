/**
 * Roomba LAN auto-discovery via UDP broadcast on port 5678.
 *
 * iRobot's local protocol: every Roomba on the subnet listens on UDP/5678 and
 * replies to the literal probe payload `irobotmcs` with a JSON descriptor. This
 * covers every generation dorita980 supports (600/700/900, i-series, j-series,
 * s-series, Braava m-series). No mDNS/Bonjour — that's never worked on any
 * Roomba firmware.
 *
 * Reference: `@karlvr/dorita980` / `dorita980` `lib/discovery.js` — the probe
 * wire format is unchanged across forks. We re-implement here rather than call
 * the library's `discovery()` so we can: (a) collect for a fixed timeout
 * (dorita980's is one-reply-and-close), (b) broadcast on every NIC's
 * subnet-directed address (some routers drop `255.255.255.255`, and HAOS
 * addons + docker bridges occasionally bind broadcasts to the wrong interface),
 * and (c) return a Promise-based Map keyed by the robot's human-visible name.
 */

import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import type { AnsiLogger } from 'matterbridge/logger';

/** Payload observed on an actual Roomba reply. */
interface RoombaProbeReply {
  /** `Roomba-<BLID>` or `iRobot-<BLID>`. */
  hostname?: string;
  /** Human-readable name the owner set in the iRobot app. */
  robotname?: string;
  /** LAN IPv4 the robot is currently announcing itself on. */
  ip?: string;
  /** Robot's own MAC, colon-separated hex. */
  mac?: string;
  /** Firmware identifier. */
  sw?: string;
  /** Product SKU (e.g. `j517020`). */
  sku?: string;
  /** `"mqtt"` on any firmware that accepts local MQTT (required for this plugin). */
  proto?: string;
}

export interface DiscoveredRobot {
  /** The IP to dial when opening the local MQTT connection. */
  ipAddress: string;
  /** The owner-visible name (matches iRobot app; used for config matching). */
  robotname: string;
  /** Robot BLID derived from `hostname.split('-')[1]`. */
  blid: string;
  /** Product SKU, for Matter BasicInformation.productName. */
  sku: string;
  /** Robot's own MAC. */
  mac?: string;
  /** Firmware version string. */
  sw?: string;
}

/** Map keyed by robot name AND by BLID — same entries, indexed twice so callers can match either. */
export interface DiscoveryResult {
  byName: Map<string, DiscoveredRobot>;
  byBlid: Map<string, DiscoveredRobot>;
}

/**
 * Enumerate IPv4 subnet-directed broadcast addresses for every active NIC.
 * Sending to these (in addition to `255.255.255.255`) dodges two failure modes:
 *   - routers/APs that drop limited broadcasts,
 *   - multi-NIC hosts where the OS default route sends `255.255.255.255` to
 *     the wrong subnet.
 */
function broadcastAddresses(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const nics of Object.values(networkInterfaces())) {
    for (const nic of nics ?? []) {
      if (nic.family !== 'IPv4' || nic.internal) continue;
      const ip = nic.address.split('.').map(Number);
      const mask = nic.netmask.split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      const bcast = ip.map((o, i) => (o & mask[i]) | (~mask[i] & 0xff)).join('.');
      out.add(bcast);
    }
  }
  return [...out];
}

/**
 * Broadcast the iRobot discovery probe and collect replies for `timeoutMs`
 * before resolving. Does NOT reject on network errors — they're logged and the
 * partial result (possibly empty) is returned. Callers can fall back to
 * config-provided IPs when the map is empty.
 */
export async function discoverRoombas(
  timeoutMs: number,
  log: AnsiLogger,
): Promise<DiscoveryResult> {
  return new Promise<DiscoveryResult>((resolve) => {
    const byName = new Map<string, DiscoveredRobot>();
    const byBlid = new Map<string, DiscoveredRobot>();
    const socket = createSocket({ type: 'udp4', reuseAddr: true });

    const finish = () => {
      try {
        socket.close();
      } catch {
        // ignore — already closed
      }
      resolve({ byName, byBlid });
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.on('error', (err) => {
      log.debug(`Roomba discovery socket error: ${err.message}`);
      clearTimeout(timer);
      finish();
    });

    socket.on('message', (msg, rinfo) => {
      let parsed: RoombaProbeReply;
      try {
        parsed = JSON.parse(msg.toString('utf8')) as RoombaProbeReply;
      } catch {
        return; // ignore non-JSON traffic (random broadcasters on the LAN)
      }
      // Filter to Roomba-shaped replies. `hostname` prefix is `Roomba-` on
      // most firmware and `iRobot-` on older Braava units.
      const hostname = parsed.hostname ?? '';
      const prefix = hostname.split('-')[0];
      if (prefix !== 'Roomba' && prefix !== 'iRobot') return;
      if (!parsed.ip) return;

      const blid = hostname.slice(prefix.length + 1); // strip `Roomba-`/`iRobot-`
      if (!blid) return;

      const entry: DiscoveredRobot = {
        ipAddress: parsed.ip,
        robotname: parsed.robotname ?? blid,
        blid,
        sku: parsed.sku ?? '',
        mac: parsed.mac,
        sw: parsed.sw,
      };
      byBlid.set(blid, entry);
      byName.set(entry.robotname, entry);
      log.debug(
        `Discovered Roomba "${entry.robotname}" (blid=${blid}, sku=${entry.sku}, ` +
          `ip=${entry.ipAddress}, from ${rinfo.address}:${rinfo.port})`,
      );
    });

    socket.bind(0, () => {
      // Enable broadcast only after bind — setting it before bind is a no-op
      // on some node builds.
      try {
        socket.setBroadcast(true);
      } catch (err) {
        log.debug(`setBroadcast failed: ${err instanceof Error ? err.message : err}`);
      }
      const probe = Buffer.from('irobotmcs', 'utf8');
      const addrs = broadcastAddresses();
      for (const addr of addrs) {
        socket.send(probe, 0, probe.length, 5678, addr, (sendErr) => {
          if (sendErr) {
            log.debug(`Broadcast to ${addr} failed: ${sendErr.message}`);
          }
        });
      }
      log.debug(
        `Roomba discovery probe sent to ${addrs.length} broadcast address(es); ` +
          `collecting replies for ${timeoutMs}ms`,
      );
    });
  });
}
