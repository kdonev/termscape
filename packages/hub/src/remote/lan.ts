import { hostname, networkInterfaces } from 'node:os';
import { lookup } from 'node:dns/promises';

/**
 * Picking the address another machine can reach us on.
 *
 * `--listen lan` exists because the alternative is asking someone to work out
 * their own IPv4 address before they can attach a second machine, which is
 * exactly the kind of step that makes a feature go unused.
 */

/**
 * How good an address is as the one to hand another machine, lower is better.
 *
 * The ordering is "who can reach me on this": a globally routable address can
 * be reached from anywhere, an RFC1918 address only from the same network, a
 * link-local one only from the same wire and usually not even then. A machine
 * with a public IP — a VPS, a box with a routable interface beside its LAN one
 * — has to advertise that one, or it hands out an address the machine being
 * attached has no route to.
 *
 * Interface kind is the tie-break rather than the rule: Docker bridges, WSL
 * adapters and VM host-only networks carry private addresses that are
 * reachable from almost nothing, so they lose to a real interface holding an
 * address of the same class.
 */
function addressRank(name: string, address: string): number {
  const virtual = /^(docker|br-|veth|vEthernet|virbr|utun|tailscale)/i.test(name) ? 1 : 0;
  if (isLinkLocalV4(address)) return 6 + virtual;
  if (isPrivateV4(address)) return 2 + virtual;
  return 0 + virtual;
}

/** RFC1918 plus the shared-address and carrier-grade NAT range. */
function isPrivateV4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** 169.254.0.0/16 — what an interface holds when DHCP never answered. */
function isLinkLocalV4(address: string): boolean {
  return address.startsWith('169.254.');
}

/**
 * The IPv4 address another machine should be pointed at.
 *
 * Public beats private beats link-local, and a real NIC beats a virtual one
 * within each class. Ties keep the order the OS reported, which is the closest
 * thing to a preference the machine itself expresses.
 */
export function lanAddress(): string | null {
  return pickLanAddress(networkInterfaces());
}

/** One entry of what `os.networkInterfaces()` returns, narrowed to what matters. */
export interface NicAddress {
  address: string;
  family: string;
  internal: boolean;
}

/**
 * The pick itself, over an interface map rather than the machine's own.
 *
 * Split out so the ordering can be tested against a machine shape that is not
 * the one running the test — a VPS with a public address beside a Docker
 * bridge is exactly the case this exists for, and no CI runner has one.
 */
export function pickLanAddress(
  interfaces: Record<string, NicAddress[] | undefined>,
): string | null {
  const candidates: { address: string; rank: number }[] = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      candidates.push({ address: a.address, rank: addressRank(name, a.address) });
    }
  }
  if (candidates.length === 0) return null;
  // Stable: only a strictly better rank moves ahead of what came first.
  return candidates.reduce((best, c) => (c.rank < best.rank ? c : best)).address;
}

/**
 * Turn a `--listen` value into a bind address.
 *
 * `lan` binds the wildcard rather than the LAN address alone, because a
 * process can only bind one address and loopback has to keep working: it is
 * where the browser opens the canvas, and where every agent's generated MCP
 * config points. Binding the LAN address by itself would take the hub off
 * 127.0.0.1 and break both. The LAN address is still what gets *advertised* —
 * see advertisedHost.
 *
 * `loopback` is the way back. It was not needed while loopback was the
 * default and nothing could be narrower; now that a hub with a UI binds wide
 * on its own, there has to be a spelling for "only this machine".
 */
export function resolveBindHost(spec: string): string {
  if (spec === 'loopback') return '127.0.0.1';
  if (spec === 'lan') {
    if (!lanAddress()) {
      throw new Error(
        '--listen lan: no non-loopback IPv4 address on this machine. ' +
          'Pass an explicit address instead.',
      );
    }
    return '0.0.0.0';
  }
  return spec;
}

/** What a hub binds and whether it hands out enrollments. */
export interface ListenPlan {
  /** The address passed to listen(). */
  host: string;
  /**
   * Whether `/join` answers. Separate from the bind on purpose: see
   * listenPlan.
   */
  enroll: boolean;
}

/**
 * Decide what to bind, and whether to hand out enrollments, from `--listen`.
 *
 * A hub with a UI binds wide by default, and hands out enrollments on that
 * bind. The canvas is worth opening on a phone or a second screen and a second
 * machine is worth attaching, and neither is discoverable from a hub that only
 * ever prints 127.0.0.1.
 *
 * Enrollment used to be the exception — reachable by default, enrollable only
 * on `--listen lan`. That was the wrong line to draw, for a plain reason: the
 * add-machine dialog is the *only* place a second machine is ever attached
 * from, and on a default hub it had nothing to show but an instruction to
 * restart with a flag. A feature reachable only by restarting the process with
 * a flag you have to already know about is a feature nobody uses, and this one
 * is the product. So the default now answers `/join`, and `--listen loopback`
 * is the way to say no.
 *
 * What that costs is worth stating plainly, because it is real: `/join` is the
 * one route served without the client token — it has to be typed by hand on a
 * machine that has nothing yet — so on a network you do not trust, anyone who
 * can reach this hub can pull the installer and put a machine on your canvas.
 * That is what `--listen loopback` is for, and what the banner says out loud on
 * every start. Everything else still needs the token.
 *
 * One thing is still *not* covered by the default:
 *
 * - **A headless hub stays on loopback, and never enrolls.** Headless means a
 *   hub that joined a canvas or was deployed over SSH, and the SSH one is
 *   reached only through its tunnel — binding it wide would put a hub on a
 *   network that its operator never asked to expose and cannot see. It has no
 *   UI to reach anyway, and a machine attaching to *it* rather than to the
 *   canvas is not a thing anyone wants.
 *
 * `hasLan` is injected so this is testable without a network interface; the
 * fallback matters because a machine with no non-loopback address must still
 * start rather than throw the way an explicit `--listen lan` does.
 */
export function listenPlan(
  spec: string | undefined,
  opts: { headless?: boolean; hasLan?: boolean } = {},
): ListenPlan {
  const hasLan = opts.hasLan ?? lanAddress() !== null;
  if (spec === undefined) {
    const wide = !opts.headless && hasLan;
    // Enrollment follows the bind, both ways: a hub that fell back to loopback
    // for want of an address has nothing to advertise and must not claim a
    // join page, and a headless one is not a canvas to attach to.
    return { host: wide ? '0.0.0.0' : '127.0.0.1', enroll: wide };
  }
  const host = resolveBindHost(spec);
  // Same rule when it was asked for by hand: anything but loopback enrolls.
  return { host, enroll: !isLoopback(host) };
}

/** Whether a bind on this address also answers on 127.0.0.1. */
export function coversLoopback(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || isLoopback(host);
}

/** Bracket a bare IPv6 literal so it can sit in a URL. */
export function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

/** Whether a bound address is reachable from anywhere but this machine. */
export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * The address to advertise for a given bind. A wildcard bind is reachable on
 * every interface, so advertise the LAN one; anything else advertises itself.
 */
export function advertisedHost(host: string): string | null {
  if (host === '0.0.0.0' || host === '::') return lanAddress();
  if (isLoopback(host)) return null;
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * The machine's own name, when it is actually usable as a URL host.
 *
 * `http://studio:7777/join` is far easier to carry to another machine than
 * `http://192.168.88.79:7777/join`, but only if that machine can resolve it —
 * Windows does it over LLMNR/NetBIOS, macOS and Linux over mDNS, and neither
 * is guaranteed. So the name is only offered when it resolves *here* to the
 * very address we bound. That is a proxy, not a promise, which is why the
 * caller keeps the numeric URL as a stated fallback rather than dropping it.
 *
 * Returns null when nothing resolves, and the caller falls back to the IP.
 */
export async function preferredHostname(
  ip: string,
  resolve: (name: string) => Promise<string[]> = defaultResolve,
): Promise<string | null> {
  const name = hostname().trim();
  if (!name || isLoopback(name)) return null;

  // Plain name first: a bare host is nicer to type than one with a suffix.
  // `.local` is the mDNS form, which is what a Mac or a Linux box will answer.
  const candidates = name.endsWith('.local') ? [name] : [name, `${name}.local`];

  for (const candidate of candidates) {
    try {
      if ((await resolve(candidate)).includes(ip)) return candidate;
    } catch {
      // Does not resolve here; try the next shape.
    }
  }
  return null;
}

async function defaultResolve(name: string): Promise<string[]> {
  const found = await lookup(name, { all: true, family: 4 });
  return found.map((a) => a.address);
}
