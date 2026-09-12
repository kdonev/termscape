import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * A workspace root is a path typed by a person, and it belongs to whichever
 * machine the workspace lives on — not to the process that happens to be
 * holding the string at the moment. `paths.ts` is the hub's own layout, all
 * of it zero-argument; a person's path is a different concern; hence a
 * separate module rather than growing that one.
 *
 * Everything here is meant to run *on the machine the path belongs to* —
 * `hub.ts` calls it for a local workspace, `peer-serve.ts` for one a peer was
 * just asked about. Calling `path.resolve` in the caller's own platform
 * flavour instead, as the code this replaces did, silently produces a
 * different path than the one typed: `win32.resolve('/Users/x/dev')` binds a
 * correct mac path to the current Windows drive, and `posix.resolve('C:\\Users\\x')`
 * treats a Windows path as one relative segment glued under whatever the
 * process's cwd happens to be. Refusing the foreign shape outright, by name,
 * is what turns that into something a person can act on instead of a folder
 * that "does not exist" for no stated reason.
 */

const WIN32 = process.platform === 'win32';

/** `C:\...` or `C:/...` — a Windows drive letter, meaningless on POSIX. */
const WIN_DRIVE = /^[A-Za-z]:[\\/]/;
/** `\\server\share` — a Windows UNC path, meaningless on POSIX. */
const WIN_UNC = /^\\\\/;
/**
 * A single leading `/` or `\`, which `path.win32.resolve` silently binds to
 * whatever drive the process happens to be running from instead of refusing.
 * Doubled (`//server/share` or `\\server\share`), it is a genuine UNC path
 * and stays allowed.
 */
const SINGLE_LEADING_SLASH = /^[\\/](?![\\/])/;

/**
 * Turn what a person typed for a workspace folder into an absolute path, on
 * the assumption that it means something *here* — call this only on the
 * machine the path belongs to.
 *
 * Expands a leading `~` the way a shell would (there is no tilde expansion
 * anywhere else in this codebase, so a bare `~/dev/x` used to become
 * `<cwd>/~/dev/x`), then refuses a path that is absolute on the *other*
 * platform rather than mangling it, then resolves whatever is left against
 * `opts.base`.
 */
export function resolveFolder(input: string, opts: { base?: string } = {}): string {
  let p = input.trim();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = homedir() + p.slice(1);
  }

  if (!WIN32 && (WIN_DRIVE.test(p) || WIN_UNC.test(p))) {
    throw new Error(`"${input}" looks like a Windows path, but this machine is not Windows`);
  }
  if (WIN32 && SINGLE_LEADING_SLASH.test(p)) {
    throw new Error(
      `"${input}" looks like a path from a Linux or macOS machine, but this machine is Windows`,
    );
  }

  return resolve(opts.base ?? process.cwd(), p);
}

/**
 * `resolveFolder`, then require the result to actually exist and be a
 * directory. `statSync().isDirectory()` rather than the `existsSync` this
 * replaces: `existsSync` accepts a plain file too, which then fails later,
 * at pty launch, with a far less useful error.
 */
export function checkFolder(input: string, opts: { base?: string } = {}): { path: string } {
  const path = resolveFolder(input, opts);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`folder does not exist: ${path}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`not a folder: ${path}`);
  }
  return { path };
}

/**
 * The last path segment, for the default workspace name when nobody typed
 * one. `path.posix.basename` cannot split a Windows path apart (it treats the
 * whole string as one segment), and a name is picked here for a folder that
 * may belong to a machine other than this process's own.
 */
export function folderName(input: string): string {
  const parts = input.trim().split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? input.trim();
}
