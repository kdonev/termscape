/**
 * Order two release versions: negative when `a` is older than `b`.
 *
 * Only as much semver as termscape's own releases use - major.minor.patch,
 * with a prerelease counting as older than the release it precedes. Anything
 * unparseable compares as equal, so a strange answer from the registry can
 * never offer an "update" that is really a downgrade.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i]! - pb.core[i]!;
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** Whether `latest` is a release newer than `current`. */
export function isNewer(latest: string | null, current: string): boolean {
  return latest !== null && compareVersions(latest, current) > 0;
}

function parse(v: string): { core: [number, number, number]; pre: string | null } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}
