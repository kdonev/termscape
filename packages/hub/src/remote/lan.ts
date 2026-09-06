import { hostname, networkInterfaces } from 'node:os';
import { lookup } from 'node:dns/promises';

/**
 * Picking the address another machine can reach us on.
 *
 * `--listen lan` exists because the alternative is asking someone to work out
 * their own IPv4 address before they can attach a second machine, which is
 * exactly the kind of step that makes a feature go unused.
 */

/** First non-internal IPv4 address, preferring real NICs over virtual ones. */
export function lanAddress(): string | null {
  const candidates: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // Docker bridges, WSL adapters and VM host-only networks are reachable
      // from almost nothing, so they lose to a real interface.
      const virtual = /^(docker|br-|veth|vEthernet|virbr|utun|tailscale)/i.test(name);
      if (virtual) candidates.push(a.address);
      else candidates.unshift(a.address);
    }
  }
  return candidates[0] ?? null;
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
 * A hub with a UI binds wide by default. The canvas is worth opening on a
 * phone or a second screen and a second machine is worth attaching, and
 * neither is discoverable from a hub that only ever prints 127.0.0.1. Every
 * route that matters still requires the client token, so what widens is which
 * interfaces answer, not who gets in.
 *
 * Two things are deliberately *not* covered by that default:
 *
 * - **A headless hub stays on loopback.** Headless means a hub that joined a
 *   canvas or was deployed over SSH, and the SSH one is reached only through
 *   its tunnel — binding it wide would put a hub on a network that its
 *   operator never asked to expose and cannot see. It has no UI to reach
 *   anyway, so there is nothing to gain against that.
 * - **Enrollment stays opt-in.** `/join` is the one route served without the
 *   token, because it has to be typed by hand on a machine that has nothing
 *   yet. A token-gated canvas on the café wi-fi is a different proposition
 *   from a page that hands anyone an installer and a slot on your canvas. So
 *   the default is reachable, and `--listen lan` is still what makes it
 *   enrollable.
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
    return { host: wide ? '0.0.0.0' : '127.0.0.1', enroll: false };
  }
  const host = resolveBindHost(spec);
  // Asking for a wider bind by hand is the deliberate act that turns the join
  // page on; it is what `--listen lan` has always meant.
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
