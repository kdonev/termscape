import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, extname } from 'node:path';
import { platform } from 'node:process';

/**
 * node-pty spawns through CreateProcess/execvp without a PATH search, so a
 * bare command like "claude" fails with an unhelpful "File not found:". Every
 * profile command therefore has to be resolved to an absolute path first.
 *
 * On Windows this also has to try PATHEXT, because the thing on PATH may be
 * claude.exe, claude.cmd or claude.bat depending on how it was installed.
 */

const isWin = platform === 'win32';

function windowsExtensions(): string[] {
  const raw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return raw.split(';').filter(Boolean);
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Absolute path to `command`, or null when it is not on PATH. */
export function which(command: string): string | null {
  // Already a path: accept it as given (with Windows extension probing).
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    if (isFile(command)) return command;
    if (isWin && extname(command) === '') {
      for (const ext of windowsExtensions()) {
        const cand = command + ext.toLowerCase();
        if (isFile(cand)) return cand;
      }
    }
    return null;
  }

  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts = isWin && extname(command) === '' ? windowsExtensions() : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const cand = join(dir, command + ext.toLowerCase());
      if (isFile(cand)) return cand;
    }
  }
  return null;
}

export interface ResolvedCommand {
  argv: string[];
  /** The executable that was found, before any shell wrapping. */
  resolved: string;
}

/**
 * Turn a profile's (command, args) into an argv node-pty can actually spawn.
 *
 * Windows batch shims (.cmd/.bat) are not executable images, so CreateProcess
 * refuses them. Many CLIs installed via npm are exactly that, so those get
 * wrapped in `cmd.exe /c`.
 */
export function resolveCommand(command: string, args: string[]): ResolvedCommand {
  const resolved = which(command);
  if (!resolved) {
    throw new Error(
      `agent command "${command}" was not found on PATH. ` +
        `Install it, or set an absolute path in the profile's "command".`,
    );
  }

  const ext = extname(resolved).toLowerCase();
  if (isWin && (ext === '.cmd' || ext === '.bat')) {
    const comspec = process.env.COMSPEC ?? 'cmd.exe';
    return { argv: [comspec, '/c', resolved, ...args], resolved };
  }

  return { argv: [resolved, ...args], resolved };
}
