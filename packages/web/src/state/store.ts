import { create } from 'zustand';
import type {
  AgentProfileInfo,
  Host,
  Message,
  Session,
  ServerMsg,
  Viewport,
  WindowRect,
  Workspace,
} from '@aicanvas/protocol';
import { HubClient } from '../net/client.js';

/** A message delivery worth drawing as an edge, with when it happened. */
export interface MessageFlash {
  id: string;
  from: string;
  to: string;
  at: number;
  failed: boolean;
}

interface AppState {
  connected: boolean;
  hubVersion: string;
  hosts: Host[];
  workspaces: Workspace[];
  sessions: Session[];
  messages: Message[];
  profiles: AgentProfileInfo[];
  viewport: Viewport;
  flashes: MessageFlash[];
  selectedId: string | null;
  /** Snapshots delivered on attach, consumed once by the terminal component. */
  pendingSnapshots: Map<string, string>;
  errors: string[];

  client: HubClient | null;
  init: (client: HubClient) => void;
  apply: (m: ServerMsg) => void;
  setConnected: (c: boolean) => void;

  setViewport: (v: Viewport) => void;
  moveWindow: (sessionId: string, rect: WindowRect) => void;
  select: (id: string | null) => void;
  takeSnapshot: (sessionId: string) => string | null;
  dismissError: (i: number) => void;
}

const upsert = <T extends { id: string }>(list: T[], item: T): T[] => {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const copy = list.slice();
  copy[i] = item;
  return copy;
};

export const useStore = create<AppState>((set, get) => ({
  connected: false,
  hubVersion: '',
  hosts: [],
  workspaces: [],
  sessions: [],
  messages: [],
  profiles: [],
  viewport: { panX: 0, panY: 0, zoom: 1 },
  flashes: [],
  selectedId: null,
  pendingSnapshots: new Map(),
  errors: [],
  client: null,

  init: (client) => set({ client }),
  setConnected: (connected) => set({ connected }),

  apply: (m) => {
    switch (m.t) {
      case 'ready':
        set({
          hubVersion: m.state.hubVersion,
          hosts: m.state.hosts,
          workspaces: m.state.workspaces,
          sessions: m.state.sessions,
          messages: m.state.messages,
          profiles: m.state.profiles,
          viewport: m.state.viewport,
        });
        return;

      case 'sessionUpserted':
        set((s) => ({ sessions: upsert(s.sessions, m.session) }));
        return;

      case 'sessionRemoved':
        set((s) => ({
          sessions: s.sessions.filter((x) => x.id !== m.sessionId),
          selectedId: s.selectedId === m.sessionId ? null : s.selectedId,
        }));
        return;

      case 'workspaceUpserted':
        set((s) => ({ workspaces: upsert(s.workspaces, m.workspace) }));
        return;

      case 'workspaceRemoved':
        set((s) => ({ workspaces: s.workspaces.filter((x) => x.id !== m.workspaceId) }));
        return;

      case 'hostUpserted':
        set((s) => ({ hosts: upsert(s.hosts, m.host) }));
        return;

      case 'hostRemoved':
        set((s) => ({ hosts: s.hosts.filter((x) => x.id !== m.hostId) }));
        return;

      case 'messageSent':
        set((s) => ({
          messages: [...s.messages, m.message].slice(-500),
          flashes: [
            ...s.flashes.filter((f) => Date.now() - f.at < 3000),
            {
              id: m.message.id,
              from: m.message.fromAddr,
              to: m.message.toAddr,
              at: Date.now(),
              failed: m.message.deliveryState === 'failed',
            },
          ],
        }));
        return;

      case 'snapshot':
        set((s) => {
          const next = new Map(s.pendingSnapshots);
          next.set(m.sessionId, m.serialized);
          return { pendingSnapshots: next };
        });
        return;

      case 'error':
        set((s) => ({ errors: [...s.errors, m.message].slice(-5) }));
        return;
    }
  },

  setViewport: (viewport) => {
    set({ viewport });
    get().client?.send({ t: 'setViewport', viewport });
  },

  moveWindow: (sessionId, rect) => {
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, window: rect } : x)),
    }));
    // The hub debounces the write, so streaming every drag frame is fine.
    get().client?.send({ t: 'moveWindow', sessionId, rect });
  },

  select: (selectedId) => set({ selectedId }),

  takeSnapshot: (sessionId) => {
    const s = get().pendingSnapshots.get(sessionId);
    if (s === undefined) return null;
    set((st) => {
      const next = new Map(st.pendingSnapshots);
      next.delete(sessionId);
      return { pendingSnapshots: next };
    });
    return s;
  },

  dismissError: (i) => set((s) => ({ errors: s.errors.filter((_, j) => j !== i) })),
}));
