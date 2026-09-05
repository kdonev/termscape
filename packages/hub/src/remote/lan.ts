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
 */
export function resolveBindHost(spec: string): string {
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
