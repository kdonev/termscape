import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_PASTE_IMAGE_BYTES,
  PASTE_IMAGE_TYPES,
  type PasteImageType,
} from '@termscape/protocol';
import { paths } from '../paths.js';

/**
 * How long a pasted image is kept. The agent CLIs read the file the moment its
 * path is pasted and carry the image in their own conversation from then on,
 * so the file only has to outlive that - a day is generous.
 */
const KEEP_MS = 24 * 60 * 60 * 1000;

export function pasteDir(sessionId: string): string {
  return join(paths.sessionDir(sessionId), 'pastes');
}

/**
 * Save an image pasted into a session's terminal and return what to paste in
 * its place: the file's absolute path.
 *
 * Runs on whichever machine owns the PTY - locally from server.ts, on a peer
 * from peer-serve.ts - because that is the machine whose agent will open the
 * path. The browser's word on type and size is checked again here rather than
 * trusted; the zod enum already refused any other mime on the way in, so the
 * lookup below cannot miss for a parsed message.
 *
 * A path with a space in it is quoted, the way a terminal quotes a file
 * dropped onto it, so the CLI does not read it as two words.
 */
export function savePastedImage(sessionId: string, mime: PasteImageType, base64: string): string {
  const ext = PASTE_IMAGE_TYPES[mime];
  if (!ext) throw new Error(`cannot paste an image of type ${mime}`);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw new Error('pasted image is empty');
  if (bytes.length > MAX_PASTE_IMAGE_BYTES) {
    throw new Error(
      `pasted image is ${bytes.length} bytes; the limit is ${MAX_PASTE_IMAGE_BYTES}`,
    );
  }

  const dir = pasteDir(sessionId);
  mkdirSync(dir, { recursive: true });
  prune(dir, Date.now());
  const file = join(dir, `${Date.now()}-${randomBytes(3).toString('hex')}.${ext}`);
  writeFileSync(file, bytes);
  return file.includes(' ') ? `"${file}"` : file;
}

/** Drop pastes older than KEEP_MS. Best effort: a file in use stays. */
export function prune(dir: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > KEEP_MS) rmSync(file, { force: true });
    } catch {
      // Held open on Windows, or gone already - either way not worth failing a paste over.
    }
  }
}
