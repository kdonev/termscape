import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  describeLive,
  joinMarker,
  LIVE_TIMEOUTS,
  startLiveCanvas,
  stopLiveCanvases,
  type LiveAgent,
  type LiveCanvas,
  type LiveWorker,
} from './harness/canvas.js';

/**
 * Issues 23 and 29: a message sent to an agent on another machine sat typed
 * in its composer and was never submitted - more often, it was thought, when
 * the message was large.
 *
 * The needle only appears once the recipient has taken a turn on the message,
 * so a message that lands and is not sent fails here on the timeout.
 */
function padded(size: number, prompt: string): string {
  const line = 'Context line, ignore it: the quick brown fox jumps over the lazy dog.\n';
  let pad = '';
  while (pad.length + line.length + prompt.length + 2 < size) pad += line;
  return `${pad}\n${prompt}`;
}

describeLive('large messages to an agent on another hub', () => {
  let canvas: LiveCanvas;
  let worker: LiveWorker;
  let alfa: LiveAgent;
  let bravo: LiveAgent;

  beforeAll(async () => {
    canvas = await startLiveCanvas({ workers: 1 });
    worker = canvas.workers[0]!;
    alfa = await canvas.startAgent({ name: 'alfa' });
    bravo = await worker.startAgent({ name: 'bravo' });
  }, LIVE_TIMEOUTS.hook);

  afterAll(stopLiveCanvases, LIVE_TIMEOUTS.hook);

  for (const size of [2000, 5000, 7900]) {
    it(`submits a ${size}-char message on the worker`, async () => {
      const marker = joinMarker(`L${size}`);
      const mcp = await alfa.mcp();
      const sent = await mcp.call<{ delivered: boolean }>('send_message', {
        to: bravo.address,
        text: padded(size, marker.prompt),
      });
      expect(sent.delivered).toBe(true);
      await canvas.waitForScreen(bravo, marker.needle, { timeoutMs: LIVE_TIMEOUTS.turn });
    }, LIVE_TIMEOUTS.test);

    it(`submits a ${size}-char message back on the canvas`, async () => {
      const marker = joinMarker(`B${size}`);
      const mcp = await bravo.mcp();
      const sent = await mcp.call<{ delivered: boolean }>('send_message', {
        to: alfa.address,
        text: padded(size, marker.prompt),
      });
      expect(sent.delivered).toBe(true);
      await canvas.waitForScreen(alfa, marker.needle, { timeoutMs: LIVE_TIMEOUTS.turn });
    }, LIVE_TIMEOUTS.test);
  }
});

describeLive('a message that lands while the remote agent is mid-turn', () => {
  let canvas: LiveCanvas;
  let alfa: LiveAgent;
  let bravo: LiveAgent;

  beforeAll(async () => {
    canvas = await startLiveCanvas({ workers: 1 });
    alfa = await canvas.startAgent({ name: 'alfa' });
    bravo = await canvas.workers[0]!.startAgent({ name: 'bravo' });
  }, LIVE_TIMEOUTS.hook);

  afterAll(stopLiveCanvases, LIVE_TIMEOUTS.hook);

  it('is still acted on once the turn it interrupted is over', async () => {
    const mcp = await alfa.mcp();
    // Keep it streaming, which is when its event loop is busiest.
    await mcp.call('send_message', {
      to: bravo.address,
      text:
        'Write a 600-word essay about lighthouses, as plain text in your reply. ' +
        'Use no tools and do not read or write any files.',
    });
    await canvas.waitFor(
      async () => /lighthouse/i.test(await bravo.screen(40)),
      'bravo to start streaming',
      LIVE_TIMEOUTS.turn,
    );
    const marker = joinMarker('MID');
    await mcp.call('send_message', { to: bravo.address, text: padded(5000, marker.prompt) });
    await canvas.waitForScreen(bravo, marker.needle, { timeoutMs: LIVE_TIMEOUTS.turn * 2 });
  }, LIVE_TIMEOUTS.test * 2);
});

