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
 * Issue 27: an agent spawns a worker, and the worker acts on its first prompt
 * and then stops hearing anything.
 *
 * The three tests are ordered so that a failure localises the fault rather
 * than just reporting one:
 *
 *   1. the whole thing on one machine - if this fails, the fault is in
 *      `spawnAgent`'s merged opening, `typeWhenReady`, or the injection itself;
 *   2. the same thing across the peer link - if only this fails, the fault is
 *      in the relay;
 *   3. two messages back to back, which is the reported symptom at its
 *      sharpest: the second arrives while the first is still being worked on.
 *
 * Every assertion is on a nonce the agent has to construct, never on a string
 * the prompt contains - see `joinMarker`. An agent CLI echoes injected text
 * into its own transcript, so asserting on the prompt's own words would pass
 * the moment the message landed, which is precisely the failure being hunted.
 */
describeLive('instructions after the first prompt', () => {
  let canvas: LiveCanvas;
  let worker: LiveWorker;
  let parent: LiveAgent;

  beforeAll(async () => {
    canvas = await startLiveCanvas({ workers: 1 });
    worker = canvas.workers[0]!;
    parent = await canvas.startAgent({ name: 'parent' });
  }, LIVE_TIMEOUTS.hook);

  afterAll(stopLiveCanvases, LIVE_TIMEOUTS.hook);

  it('a spawned child on this machine takes a second instruction', async () => {
    const first = joinMarker('ONE');
    const second = joinMarker('TWO');
    const mcp = await parent.mcp();

    const child = await mcp.call<{ address: string; promptQueued: boolean }>('spawn_agent', {
      name: 'localkid',
      prompt: first.prompt,
    });
    expect(child.promptQueued).toBe(true);

    await canvas.waitForScreen(child.address, first.needle, {
      timeoutMs: LIVE_TIMEOUTS.agentBoot,
      label: `the spawn prompt to be acted on by ${child.address}`,
    });

    const sent = await mcp.call<{ delivered: boolean }>('send_message', {
      to: child.address,
      text: second.prompt,
    });
    expect(sent.delivered).toBe(true);

    await canvas.waitForScreen(child.address, second.needle, {
      timeoutMs: LIVE_TIMEOUTS.turn,
      label: `the second instruction to be acted on by ${child.address}`,
    });
  }, LIVE_TIMEOUTS.test);

  it('a spawned child on the other hub takes a second instruction', async () => {
    const first = joinMarker('RONE');
    const second = joinMarker('RTWO');
    const mcp = await parent.mcp();

    const child = await mcp.call<{ address: string; host: string; promptQueued: boolean }>(
      'spawn_agent',
      {
        name: 'remotekid',
        host: worker.label,
        workspace: worker.workspace.name,
        prompt: first.prompt,
      },
    );
    expect(child.host).toBe(worker.label);
    expect(child.promptQueued).toBe(true);
    expect(canvas.hub.peers.hostIdFor(child.address)).toBe(worker.hostId);

    await canvas.waitForScreen(child.address, first.needle, {
      timeoutMs: LIVE_TIMEOUTS.agentBoot,
      label: `the relayed spawn prompt to be acted on by ${child.address}`,
    });

    const sent = await mcp.call<{ delivered: boolean }>('send_message', {
      to: child.address,
      text: second.prompt,
    });
    expect(sent.delivered).toBe(true);

    await canvas.waitForScreen(child.address, second.needle, {
      timeoutMs: LIVE_TIMEOUTS.turn,
      label: `the relayed second instruction to be acted on by ${child.address}`,
    });
  }, LIVE_TIMEOUTS.test);

  it('takes two instructions sent back to back', async () => {
    const first = joinMarker('BONE');
    const second = joinMarker('BTWO');
    const mcp = await parent.mcp();

    const child = await mcp.call<{ address: string }>('spawn_agent', { name: 'busykid' });
    // Wait for it to be listening before testing what happens to a message
    // that arrives mid-turn: otherwise a failure could just as well be a CLI
    // that had not started reading yet.
    const hello = joinMarker('HI');
    await mcp.call('send_message', { to: child.address, text: hello.prompt });
    await canvas.waitForScreen(child.address, hello.needle, {
      timeoutMs: LIVE_TIMEOUTS.agentBoot,
    });

    await mcp.call('send_message', { to: child.address, text: first.prompt });
    await mcp.call('send_message', { to: child.address, text: second.prompt });

    // Both, not either: one swallowed message is the bug.
    await canvas.waitForScreen(child.address, first.needle, {
      timeoutMs: LIVE_TIMEOUTS.turn,
      label: 'the first of two back-to-back instructions',
    });
    await canvas.waitForScreen(child.address, second.needle, {
      timeoutMs: LIVE_TIMEOUTS.turn,
      label: 'the second of two back-to-back instructions',
    });
  }, LIVE_TIMEOUTS.test);
});
