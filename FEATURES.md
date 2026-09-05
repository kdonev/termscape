# Features

Wanted features, next first. Each entry says what it is, how it should behave,
and where the code lives. Delete an entry when it ships — the git history keeps
the record.

---

## 1. A sliding tree panel for hosts, workspaces and agents

**What it is.** A panel that slides in from the right edge of the screen and
holds one tree:

```
this machine
  ├─ aicanvas            ~/dev/aiCliCanvas
  │    ├─ claude-1       running · idle
  │    └─ shell-2        stopped
  └─ notes               ~/notes
studio  (darwin-arm64 · hub 0.4.1)
  └─ api                 /srv/api
       └─ claude-1       running · busy
```

Host at the top level, its workspaces under it, the agents in each workspace
under that. This machine is always the first root, even with no remote hosts —
it is where most workspaces live, and it should not be the one thing in the
system without a place in the tree.

**How it behaves.**

- **Sliding, not a dropdown.** A tab or a keyboard shortcut slides the panel
  over the right of the canvas and back out. Closed is the default: the canvas
  is the application, this is the index to it. It overlays rather than reflows,
  so the canvas does not jump when it opens.
- **Everything is added and removed here.** Adding a host, adding a workspace
  to a host, starting an agent in a workspace — each is an action on the node
  it belongs to, at the level it belongs to, rather than three unrelated
  controls in one strip along the top. Removing is the same: remove a host,
  remove a workspace, stop or remove an agent, each from its own row.
- **Add is inline.** Adding a workspace under a host opens the folder-path and
  name fields on that host's node, with the host already chosen — one field
  fewer to fill in than today's toolbar, and no way to add a workspace to a
  machine you did not mean.
- **Removing says what goes with it.** Removing a workspace that still has
  agents in it, or a host that still has workspaces, confirms first and names
  what else it takes. `removeHost` already stops the hub on that machine, so
  this is not an undoable click.
- **The tree and the canvas are the same selection.** Clicking an agent selects
  its window and brings the canvas to it; selecting a window on the canvas
  highlights its row in the tree. The tree is how you find an agent you have
  panned away from.
- **State is legible per row.** Host connection state (the four colours the
  hosts panel already uses), session state, and the agent's own busy/idle
  status, each shown where the thing lives.

**Where it lives.**

- `packages/web/src/Toolbar.tsx` — the workspace form, the host picker, the
  profile picker and *start agent* all move into the panel. What is left in the
  toolbar is the brand, the connection chip and the message log.
- `packages/web/src/Hosts.tsx:13` — the hosts panel becomes the host level of
  the tree. The two tabs behind it (*join from that machine*, *deploy over ssh*)
  stay as they are; they are the "add host" action of the root level.
- `packages/web/src/state/store.ts:30` — the store already holds `hosts`,
  `workspaces` and `sessions` as flat arrays and `selectedId` for the canvas
  selection. The tree is a derived grouping over those, plus the panel's own
  open/closed and expanded-node state. Note `Workspace.hostId` is `null` for
  this machine, and `hosts` holds only remotes — the local root is synthetic.
- `packages/protocol/src/ws.ts:64` — no protocol change needed. Every action
  the panel offers already exists as a client message: `createWorkspace`,
  `removeWorkspace`, `startSession`, `stopSession`, `removeSession`,
  `resumeSession`, `addHost`, `removeHost`, `connectHost`.
- `packages/web/src/canvas/viewport.ts:245` — `focusRect` is what "click an
  agent, go to it" should use, the same path the maximize button takes.
- `packages/web/src/styles.css` — the slide transform and the overlay. Animate
  `transform`, not `width`, so opening the panel never relayouts the canvas
  underneath it.
