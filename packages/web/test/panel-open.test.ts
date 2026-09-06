import { describe, expect, it } from 'vitest';
import { useStore } from '../src/state/store.js';

/*
 * Clicking the canvas closes the panel, which means setPanelOpen(false) runs on
 * every pointer down anywhere on the canvas - and most of those happen with the
 * panel already shut. Each store write is a new state object and a re-render for
 * everything subscribed, terminals included, so the write that changes nothing
 * has to notify nobody.
 */
describe('setPanelOpen', () => {
  it('changes the flag', () => {
    useStore.getState().setPanelOpen(true);
    expect(useStore.getState().panelOpen).toBe(true);
    useStore.getState().setPanelOpen(false);
    expect(useStore.getState().panelOpen).toBe(false);
  });

  it('notifies nobody when the value is already what was asked for', () => {
    useStore.getState().setPanelOpen(false);
    let notified = 0;
    const stop = useStore.subscribe(() => notified++);
    try {
      useStore.getState().setPanelOpen(false);
      expect(notified).toBe(0);
      useStore.getState().setPanelOpen(true);
      expect(notified).toBe(1);
    } finally {
      stop();
      useStore.getState().setPanelOpen(false);
    }
  });
});
