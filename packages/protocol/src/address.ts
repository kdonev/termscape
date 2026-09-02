/** Agent addressing: `workspace/name`, unique across all connected hubs. */

export interface ParsedAddress {
  workspace: string;
  name: string;
}

export function makeAddress(workspace: string, name: string): string {
  return `${workspace}/${name}`;
}

export function parseAddress(addr: string): ParsedAddress | null {
  const i = addr.indexOf('/');
  if (i <= 0 || i === addr.length - 1) return null;
  const workspace = addr.slice(0, i);
  const name = addr.slice(i + 1);
  if (name.includes('/')) return null;
  return { workspace, name };
}

/** Lowercase, hyphenated, safe for use in an address segment. */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length > 0 ? s.slice(0, 40) : 'agent';
}

/**
 * Allocate a name unique within `taken`, suffixing -2, -3, ... on collision.
 * Deterministic, so restoring a workspace reproduces the same names.
 */
export function uniqueName(desired: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  const base = slugify(desired);
  if (!set.has(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${base}-${n}`;
    if (!set.has(candidate)) return candidate;
  }
  throw new Error(`could not allocate a unique name for "${desired}"`);
}
