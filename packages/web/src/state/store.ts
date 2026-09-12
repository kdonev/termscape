import { create } from 'zustand';
import type {
  AckableMsg,
  AgentProfileInfo,
  AgentTemplateInfo,
  TemplateProposal,
  Host,
  Message,
  Note,
  Session,
  ServerMsg,
  ShareInfo,
  Viewport,
  WindowRect,
  Workspace,
} from '@termscape/protocol';
import { HubClient } from '../net/client.js';

/** A message delivery worth drawing as an edge, with when it happened. */
export interface MessageFlash {
  id: string;
  from: string;
  to: string;
  at: number;
  failed: boolean;
}

/**
 * Which dialog is up, and what it is about.
 *
 * In the store rather than in a component because a dialog is not owned by
 * the node that opened it: the same edit is reachable from a tree row, from a
 * keyboard shortcut and eventually from the canvas, and only one may be up at
 * a time. Each variant carries an id rather than the object, so a dialog left
 * open while the hub sends an update redraws from current state instead of
 * from whatever was true when it opened.
 */
export type DialogSpec =
  | { kind: 'addWorkspace'; hostId: string | null }
  | { kind: 'editWorkspace'; workspaceId: string }
  | { kind: 'startAgent'; workspaceId: string }
  /**
   * Make a template, or edit one. `id` is absent for a new one and present
   * for an edit — including editing an agent's own derived template, where
   * saving creates a stored one that shadows it.
   */
  | { kind: 'saveTemplate'; id: string | null }
  /** An agent's proposal, waiting on a human to accept, edit or decline it. */
  | { kind: 'reviewTemplate'; proposalId: string }
  | { kind: 'addMachine' }
  | { kind: 'editMachine'; hostId: string }
  /** The link for one session: copy it, or stop sharing. */
  | { kind: 'share'; sessionId: string }
  /**
   * Destructive confirmation. The message to send is carried rather than a
   * callback, so the dialog needs to know nothing about what it is confirming
   * and every removal in the app reads the same way.
   */
  | {
      kind: 'confirm';
      title: string;
      body: string;
      confirmLabel: string;
      send: AckableMsg;
    };

interface AppState {
  connected: boolean;
  hubVersion: string;
  /** The join page's URL, or null when the hub is bound to loopback. */
  enrollUrl: string | null;
  /** The same page by IP, for a network that cannot resolve the name. */
  enrollAltUrl: string | null;
  /**
   * Where another machine can reach this hub at all, or null when it is
   * bound to loopback. What a share link is built from - unlike `enrollUrl`,
   * it exists whether or not enrollment is on: sharing one terminal is a
   * different grant with a different audience.
   */
  lanOrigin: string | null;
  /** The same origin by IP, when `lanOrigin` uses this machine's name. */
  lanAltOrigin: string | null;
  hosts: Host[];
  /** Deploy output per host, newest last. Cleared when a host is removed. */
  hostLogs: Record<string, string[]>;
  workspaces: Workspace[];
  sessions: Session[];
  messages: Message[];
  /** What this machine has installed. */
  profiles: AgentProfileInfo[];
  /** What the picker offers: an agent plus what has already been chosen for it. */
  templates: AgentTemplateInfo[];
  templateProposals: TemplateProposal[];
  /**
   * What each attached machine has, by host id. Per machine because a host
   * has its own PATH: starting an agent on a workspace over there sends a
   * profile id that machine resolves against its own config, so offering one
   * it does not have only fails later, in a terminal window, as a spawn error.
   */
  hostProfiles: Record<string, AgentProfileInfo[]>;
  /** Which sessions are shared, and the token each link carries. */
  shares: ShareInfo[];
  /**
   * Sticky notes, free-floating on the canvas. Not scoped to a workspace or a
   * session and never sent to a peer hub - see the `Note` doc in the protocol.
   */
  notes: Note[];
  viewport: Viewport;
  flashes: MessageFlash[];
  selectedId: string | null;
  /**
   * Which note is selected, kept separate from `selectedId`.
   *
   * `selectedId` names a session and drives terminal focus and the Ctrl+2
   * zoom - things a note has no equivalent of. Folding notes into it would
   * mean every reader of `selectedId` (the terminal that grabs the keyboard
   * on selection, `toggleMaximize`) now has to first check what kind of thing
   * it points at. Selecting one clears the other; see `select`/`selectNote`.
   */
  selectedNoteId: string | null;
  /**
   * A request from outside the canvas to bring one window into view. The
   * canvas owns the viewport and the animation, so this is a request rather
   * than a viewport: the timestamp is what makes asking twice for the same
   * window a second request rather than a no-op.
   *
   * `alsoId` widens the frame to a second window — a child the focused
   * terminal just spawned — without moving the selection, so the parent keeps
   * the keyboard and both stay in view.
   */
  focusRequest: { sessionId: string; at: number; alsoId?: string } | null;
  /** Whether the tree panel is slid out over the canvas. */
  panelOpen: boolean;
  /** The one dialog that is up, or null. */
  dialog: DialogSpec | null;
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
  selectNote: (id: string | null) => void;
  putNote: (note: Note) => void;
  removeNote: (id: string) => void;
  /** Create a note centred on a world point, put it, and select it. */
  createNoteAt: (p: { x: number; y: number }) => void;
  requestFocus: (sessionId: string) => void;
  setPanelOpen: (open: boolean) => void;
  openDialog: (spec: DialogSpec) => void;
  closeDialog: () => void;
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
  enrollUrl: null,
  enrollAltUrl: null,
  lanOrigin: null,
  lanAltOrigin: null,
  hosts: [],
  hostLogs: {},
  workspaces: [],
  sessions: [],
  messages: [],
  profiles: [],
  templates: [],
  templateProposals: [],
  hostProfiles: {},
  shares: [],
  notes: [],
  viewport: { panX: 0, panY: 0, zoom: 1 },
  flashes: [],
  selectedId: null,
  selectedNoteId: null,
  focusRequest: null,
  panelOpen: false,
  dialog: null,
  pendingSnapshots: new Map(),
  errors: [],
  client: null,

  init: (client) => set({ client }),
  setConnected: (connected) => set({ connected }),

  apply: (m) => {
    switch (m.t) {
      case 'ready':
        set((s) => ({
          hubVersion: m.state.hubVersion,
          enrollUrl: m.state.enrollUrl,
          enrollAltUrl: m.state.enrollAltUrl,
          lanOrigin: m.state.lanOrigin,
          lanAltOrigin: m.state.lanAltOrigin,
          hosts: m.state.hosts,
          workspaces: m.state.workspaces,
          sessions: m.state.sessions,
          messages: m.state.messages,
          profiles: m.state.profiles,
          templates: m.state.templates,
          templateProposals: m.state.templateProposals,
          hostProfiles: m.state.hostProfiles,
          shares: m.state.shares,
          notes: m.state.notes,
          viewport: m.state.viewport,
          // This arrives on every reconnect, not only the first, so it can
          // replace the session list under a selection made before the hub
          // restarted. Keeping that id would point the canvas at a window
          // nothing draws any more.
          selectedId: m.state.sessions.some((x) => x.id === s.selectedId)
            ? s.selectedId
            : null,
          selectedNoteId: m.state.notes.some((n) => n.id === s.selectedNoteId)
            ? s.selectedNoteId
            : null,
        }));
        return;

      case 'sessionUpserted': {
        // A window nobody asked for is a spawn: when the focused terminal
        // just created one, widen the view so parent and child are both in
        // frame. Selection stays on the parent — it asked for the child, and
        // it keeps the keyboard.
        const fresh = !get().sessions.some((x) => x.id === m.session.id);
        set((s) => ({ sessions: upsert(s.sessions, m.session) }));
        if (fresh && m.session.spawnedBy && m.session.spawnedBy === get().selectedId) {
          set({
            focusRequest: {
              sessionId: m.session.id,
              at: Date.now(),
              alsoId: m.session.spawnedBy,
            },
          });
        }
        return;
      }

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

      case 'templatesChanged':
        // The whole list, because one write can change a row nobody touched:
        // removing a stored template reveals the derived one underneath it.
        set({ templates: m.templates });
        return;

      case 'templateProposed':
        /*
         * Opened in front of whoever is looking, because that is the whole
         * point - an agent is waiting on an answer. Not if a dialog is already
         * open though: replacing one mid-edit would throw away what somebody
         * was typing, and the proposal is listed under the templates root
         * until it is answered.
         */
        set((s) => ({
          templateProposals: [...s.templateProposals, m.proposal],
          dialog: s.dialog ?? { kind: 'reviewTemplate', proposalId: m.proposal.id },
        }));
        return;

      case 'templateProposalResolved':
        set((s) => ({
          templateProposals: s.templateProposals.filter((p) => p.id !== m.proposalId),
          // Answered elsewhere - another browser, or this one. Either way the
          // dialog is about something that is no longer waiting.
          dialog:
            s.dialog?.kind === 'reviewTemplate' && s.dialog.proposalId === m.proposalId
              ? null
              : s.dialog,
        }));
        return;

      case 'hostUpserted':
        set((s) => ({ hosts: upsert(s.hosts, m.host) }));
        return;

      case 'hostRemoved':
        set((s) => {
          const { [m.hostId]: _gone, ...hostLogs } = s.hostLogs;
          return { hosts: s.hosts.filter((x) => x.id !== m.hostId), hostLogs };
        });
        return;

      case 'sharesChanged':
        // The whole list, same reasoning as `templatesChanged`: it is a
        // handful of small records, recomputed on the hub rather than
        // patched, so there is nothing here to diff against.
        set({ shares: m.shares });
        return;

      case 'noteUpserted':
        // Arrives only from another socket - the hub never echoes a write
        // back to its sender (see `broadcastExcept` in server.ts) - so this
        // never overwrites an in-flight drag or an active caret with a stale
        // copy of itself.
        set((s) => ({ notes: upsert(s.notes, m.note) }));
        return;

      case 'noteRemoved':
        set((s) => ({
          notes: s.notes.filter((n) => n.id !== m.noteId),
          selectedNoteId: s.selectedNoteId === m.noteId ? null : s.selectedNoteId,
        }));
        return;

      case 'hostLog':
        set((s) => ({
          hostLogs: {
            ...s.hostLogs,
            // Bounded: a deploy is chatty and nobody scrolls back past the
            // last few lines while waiting for it.
            [m.hostId]: [...(s.hostLogs[m.hostId] ?? []), m.line].slice(-8),
          },
        }));
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

      case 'agentsDetected':
        // Arrives after `ready`, once each machine has probed its own PATH.
        set((s) =>
          m.hostId === null
            ? { profiles: m.profiles }
            : { hostProfiles: { ...s.hostProfiles, [m.hostId]: m.profiles } },
        );
        return;

      case 'ack':
        // HubClient settles the promise and returns before this; the case
        // exists so the switch stays exhaustive and adding a message type
        // keeps being a compile error rather than a silent no-op.
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

  // Selecting a session and selecting a note are mutually exclusive - the
  // canvas has one thing with the keyboard's attention at a time - so each
  // clears the other rather than leaving a stale note ring or a stale
  // terminal focus behind.
  select: (selectedId) => set({ selectedId, selectedNoteId: null }),

  selectNote: (selectedNoteId) => set({ selectedNoteId, selectedId: null }),

  putNote: (note) => {
    set((s) => ({ notes: upsert(s.notes, note) }));
    get().client?.send({ t: 'putNote', note });
  },

  removeNote: (id) => {
    set((s) => ({
      notes: s.notes.filter((n) => n.id !== id),
      selectedNoteId: s.selectedNoteId === id ? null : s.selectedNoteId,
    }));
    get().client?.send({ t: 'removeNote', noteId: id });
  },

  createNoteAt: (p) => {
    const NOTE_W = 220;
    const NOTE_H = 180;
    const z = Math.max(0, ...get().notes.map((n) => n.z)) + 1;
    const note: Note = {
      id: crypto.randomUUID(),
      x: p.x - NOTE_W / 2,
      y: p.y - NOTE_H / 2,
      w: NOTE_W,
      h: NOTE_H,
      z,
      text: '',
      color: 'yellow',
      updatedAt: Date.now(),
    };
    get().putNote(note);
    get().selectNote(note.id);
  },

  requestFocus: (sessionId) =>
    set({ selectedId: sessionId, selectedNoteId: null, focusRequest: { sessionId, at: Date.now() } }),

  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set((s) => (s.dialog === null ? s : { dialog: null })),

  // Guarded rather than a plain write: clicking the canvas closes the panel,
  // and most canvas clicks happen with it already shut. Returning the state
  // itself is zustand's no-op - it bails on Object.is before notifying, so a
  // click on empty canvas re-renders nothing.
  setPanelOpen: (panelOpen) =>
    set((s) => (s.panelOpen === panelOpen ? s : { panelOpen })),

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
