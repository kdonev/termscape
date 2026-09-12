/**
 * Pull a share token out of the URL path, or null when this is not a share
 * link.
 *
 * Pure, and unit-tested the way `grid.ts` and `viewport.ts` are, so the one
 * branch that decides "share link or ordinary canvas" in App.tsx is a single
 * call rather than string-slicing spread across a component.
 *
 * The token lives in the path itself, `/t/<token>`, rather than a `?token=`
 * query string. That is the opposite of the canvas token in App.tsx's
 * `resolveToken`, which is deliberately stripped out of the URL into
 * `sessionStorage` on arrival - a share link has to do the reverse and
 * survive a refresh and a bookmark, so it stays exactly where it is.
 */
export function shareTokenFromPath(pathname: string): string | null {
  const m = /^\/t\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  const token = decodeURIComponent(m[1]!);
  return token.length > 0 ? token : null;
}
