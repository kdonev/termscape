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
 * Two hubs, two real agents, and a message crossing between them.
 *
 * This is the harness proving itself. `peer.test.ts` and `enroll.test.ts`
 * already cover the peer protocol with plain shells and an in-process join;
 * what is new here is that the second hub is a real child process that ran the
 * real `--join` handshake, and that the things being messaged are actual agent
 * CLIs - so a delivery that lands in a composer and is never submitted fails
 * here, where no amount of protocol testing would show it.
 *
 * Both directions are exercised on purpose. Canvas to worker goes out through
 * the peer link's `deliver`; worker to canvas comes back up through the
 * uplink's relay, which is a different code path on both hubs.
 */
describeLive('two hubs, a real agent on each', () => {
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

  it('joined as an enrolled host, with no SSH details', () => {
    const host = canvas.hub.store.listHosts().find((h) => h.id === worker.hostId);
    expect(host).toBeDefined();
    expect(host!.kind).toBe('enrolled');
    expect(host!.state).toBe('connected');
    // It dialled us; there was never an SSH connection to describe.
    expect(host!.sshHost).toBeNull();
    expect(host!.sshUser).toBeNull();
  });

  it('put the second agent on the other hub, not this one', () => {
    expect(canvas.hub.peers.hostIdFor(bravo.address)).toBe(worker.hostId);
    // The canvas holds no PTY for it: the process lives in the child hub.
    expect(canvas.hub.sessions.getByAddress(bravo.address)).toBeFalsy();
    expect(canvas.hub.sessions.getByAddress(alfa.address)).toBeTruthy();
  });

  it('delivers a message from the canvas to an agent on the worker', async () => {
    const marker = joinMarker('XHUB');
    const mcp = await alfa.mcp();

    const sent = await mcp.call<{ delivered: boolean }>('send_message', {
      to: bravo.address,
      text: marker.prompt,
    });
    expect(sent.delivered).toBe(true);

    await canvas.waitForScreen(bravo, marker.needle, { timeoutMs: LIVE_TIMEOUTS.turn });

    // And the same screen read the way an agent reads it - through the relay,
    // with the visibility check in front of it.
    const seen = await mcp.call<{ screen: string }>('read_screen', {
      address: bravo.address,
      lines: 80,
    });
    expect(seen.screen).toContain(marker.needle);
  }, LIVE_TIMEOUTS.test);

  it('delivers a message from the worker back to the canvas', async () => {
    const marker = joinMarker('BACK');
    const mcp = await bravo.mcp();

    const sent = await mcp.call<{ delivered: boolean }>('send_message', {
      to: alfa.address,
      text: marker.prompt,
    });
    expect(sent.delivered).toBe(true);

    await canvas.waitForScreen(alfa, marker.needle, { timeoutMs: LIVE_TIMEOUTS.turn });
  }, LIVE_TIMEOUTS.test);

  it('shows each agent the other machine and the other agent', async () => {
    const mcp = await alfa.mcp();

    const hosts = await mcp.call<{ label: string; agents?: { id: string }[] }[]>('list_hosts');
    const labels = hosts.map((h) => h.label);
    expect(labels).toContain('canvas');
    expect(labels).toContain(worker.label);

    const agents = await mcp.call<{ address: string }[]>('list_agents');
    expect(agents.map((a) => a.address)).toContain(bravo.address);
  }, LIVE_TIMEOUTS.test);
});
