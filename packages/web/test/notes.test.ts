import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubState, Note } from '@termscape/protocol';
import { useStore } from '../src/state/store.js';

/*
 * Notes are free-floating canvas objects with their own selection, separate
 * from a session's - the store is what has to keep the two from fighting over
 * one keyboard, and what has to turn a double-click point into an actual note
 * at the right place, on top of the stack.
 */

let n = 0;
const note = (over: Partial<Note> = {}): Note => ({
  id: `note${++n}`,
  x: 0,
  y: 0,
  w: 220,
  h: 180,
  z: 0,
  text: '',
  color: 'yellow',
  updatedAt: 0,
  ...over,
});

const readyState = (over: Partial<HubState> = {}): HubState => ({
  hubVersion: '0.0.0',
  enrollUrl: null,
  enrollAltUrl: null,
  lanOrigin: null,
  lanAltOrigin: null,
  hosts: [],
  workspaces: [],
  sessions: [],
  messages: [],
  viewport: { panX: 0, panY: 0, zoom: 1 },
  profiles: [],
  templates: [],
  templateProposals: [],
  hostProfiles: {},
  shares: [],
  notes: [],
  ...over,
});

const reset = (): void => {
  useStore.setState({
    sessions: [],
    selectedId: null,
    notes: [],
    selectedNoteId: null,
    client: null,
  });
};

beforeEach(reset);

describe('apply(ready)', () => {
  it('replaces the note list', () => {
    const a = note({ id: 'a' });
    useStore.getState().apply({ t: 'ready', state: readyState({ notes: [a] }) });
    expect(useStore.getState().notes).toEqual([a]);
  });

  it('keeps selectedNoteId only when that note still exists', () => {
    useStore.setState({ selectedNoteId: 'gone' });
    useStore.getState().apply({ t: 'ready', state: readyState({ notes: [note({ id: 'still-here' })] }) });
    expect(useStore.getState().selectedNoteId).toBeNull();

    useStore.setState({ selectedNoteId: 'still-here' });
    useStore.getState().apply({ t: 'ready', state: readyState({ notes: [note({ id: 'still-here' })] }) });
    expect(useStore.getState().selectedNoteId).toBe('still-here');
  });
});

describe('noteUpserted / noteRemoved', () => {
  it('upserts into the list', () => {
    const a = note({ id: 'a', text: 'first' });
    useStore.setState({ notes: [a] });

    useStore.getState().apply({ t: 'noteUpserted', note: { ...a, text: 'edited' } });
    expect(useStore.getState().notes).toEqual([{ ...a, text: 'edited' }]);

    const b = note({ id: 'b' });
    useStore.getState().apply({ t: 'noteUpserted', note: b });
    expect(useStore.getState().notes.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('removes from the list and clears the selection if it was the removed one', () => {
    const a = note({ id: 'a' });
    useStore.setState({ notes: [a], selectedNoteId: 'a' });

    useStore.getState().apply({ t: 'noteRemoved', noteId: 'a' });

    expect(useStore.getState().notes).toEqual([]);
    expect(useStore.getState().selectedNoteId).toBeNull();
  });

  it('leaves an unrelated selection alone', () => {
    useStore.setState({ notes: [note({ id: 'a' }), note({ id: 'b' })], selectedNoteId: 'b' });
    useStore.getState().apply({ t: 'noteRemoved', noteId: 'a' });
    expect(useStore.getState().selectedNoteId).toBe('b');
  });
});

describe('select / selectNote', () => {
  it('clear each other - only one thing owns the keyboard at a time', () => {
    useStore.setState({ selectedNoteId: 'a-note' });
    useStore.getState().select('a-session');
    expect(useStore.getState()).toMatchObject({ selectedId: 'a-session', selectedNoteId: null });

    useStore.getState().selectNote('a-note');
    expect(useStore.getState()).toMatchObject({ selectedId: null, selectedNoteId: 'a-note' });
  });
});

describe('createNoteAt', () => {
  it('centres a default-sized note on the point, puts z on top, and selects it', () => {
    const send = vi.fn();
    useStore.setState({
      notes: [note({ id: 'a', z: 3 }), note({ id: 'b', z: 1 })],
      client: { send } as any,
    });

    useStore.getState().createNoteAt({ x: 500, y: 400 });

    const created = useStore.getState().notes.find((n) => n.id !== 'a' && n.id !== 'b')!;
    expect(created).toBeDefined();
    expect(created.z).toBe(4); // one above the current top (3)
    expect(created.color).toBe('yellow');
    // Centred: the point is the note's midpoint, not its corner.
    expect(created.x).toBe(500 - created.w / 2);
    expect(created.y).toBe(400 - created.h / 2);

    expect(useStore.getState().selectedNoteId).toBe(created.id);
    expect(send).toHaveBeenCalledWith({ t: 'putNote', note: created });
  });

  it('starts z at 1 on an empty canvas', () => {
    const send = vi.fn();
    useStore.setState({ notes: [], client: { send } as any });

    useStore.getState().createNoteAt({ x: 0, y: 0 });

    expect(useStore.getState().notes[0]!.z).toBe(1);
  });
});
