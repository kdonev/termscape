import { describe, expect, it } from 'vitest';
import {
  BinaryFrameKind,
  decodeBinaryFrame,
  encodeBinaryFrame,
} from '../src/ws.js';

/*
 * The input path has to be byte-faithful.
 *
 * Mouse reports in the default encoding spell a coordinate as `32 + n`, so a
 * click past column 95 contains a byte above 0x7f. Treated as text anywhere on
 * the way to the pty, that byte becomes two - and the program, unable to parse
 * the report it asked for, prints the wreckage. That is what made moving the
 * mouse over a wide terminal type garbage into it.
 */
describe('binary frames', () => {
  it('carries every byte value through unchanged', () => {
    const payload = new Uint8Array(256);
    for (let i = 0; i < 256; i++) payload[i] = i;

    const f = decodeBinaryFrame(
      encodeBinaryFrame(BinaryFrameKind.PtyInputRaw, 'ws/agent-1', payload),
    );

    expect(f.kind).toBe(BinaryFrameKind.PtyInputRaw);
    expect(f.sessionId).toBe('ws/agent-1');
    expect([...f.payload]).toEqual([...payload]);
  });

  it('keeps raw input distinguishable from text input', () => {
    // The hub decodes one as UTF-8 and writes the other as bytes, so the two
    // must never collapse into the same kind.
    expect(BinaryFrameKind.PtyInputRaw).not.toBe(BinaryFrameKind.PtyInput);
  });

  it('survives the latin1 hop a peer link makes it take', () => {
    // Crossing to another hub, a raw payload rides in JSON. latin1 is the one
    // encoding that maps each byte to exactly one code unit and back.
    const report = Uint8Array.from([0x1b, 0x5b, 0x4d, 0x20, 0xc8, 0xa0]);
    const asString = Buffer.from(report).toString('latin1');
    const back = Buffer.from(JSON.parse(JSON.stringify(asString)) as string, 'latin1');
    expect([...back]).toEqual([...report]);
  });
});
