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

---

## 2. The join script should not reinstall dependencies every time

**What it is.** Re-running the join command on a machine that has already
joined spends a minute or two on `npm install`, every time, even when nothing
about the dependency set has changed. Re-joining is the supported way to update
or repair a machine, so this is the ordinary path rather than the first-run
one — and it is the slowest step in it.

**Why it happens.** Step 2 deletes the whole install before unpacking the new
one, and `node_modules` is inside it:

```sh
rm -rf "$HOME_DIR/hub"          # join-script.ts:215
tar xzf "$HOME_DIR/hub.tgz" -C "$HOME_DIR/hub" --strip-components=1
```

So by the time step 3 runs there is nothing left to reuse, and `node-pty` and
`better-sqlite3` are fetched or compiled again from scratch. Node itself is
already handled the right way — a private copy in `~/.aicanvas/node` is
detected and reused when it is version 22 or newer — and this is the same
treatment for the layer underneath it.

**How it should behave.**

- **Replace the shipped files, keep `node_modules`.** Unpack over the install
  rather than deleting it, and remove only what the new tarball does not
  replace. A re-join then starts with the previous dependency tree in place.
- **Skip the install when the dependency set is unchanged.** Record a stamp
  next to the install after a successful install, and compare before running
  one. Print the skip — these scripts are deliberately chatty, and "reused the
  dependencies already here" is as informative as a ticking progress line.
- **The stamp has to cover everything that invalidates the tree**, or the
  optimization turns into a machine that will not start:
  - the hub's dependency block, so a version change reinstalls;
  - the vendored `@aicanvas/protocol` tarball's hash. It is a `file:`
    dependency (`pack-hub.mjs:40`) and its content changes on every hub build
    even when its version does not, so versions alone would miss it. It has no
    native code, so refreshing just that one is cheap;
  - the Node major version, because `node-pty` and `better-sqlite3` are
    compiled against a specific ABI and a Node upgrade silently invalidates
    them;
  - platform and architecture, for a home directory that came from a backup or
    a moved disk.
- **Verify before trusting the stamp.** A one-line `require` of both native
  modules under the Node about to run the hub, and on any failure fall through
  to the full install. Skipping is an optimization; a hub that cannot load its
  own modules is worse than a slow install.
- **Both scripts, and the SSH path.** All three do the same thing today and
  should end up doing the same thing after.

**Where it lives.**

- `packages/hub/src/remote/join-script.ts:215` — the POSIX `rm -rf`, and
  `:221` the dependency step whose `run_ticking "installing"` is what we are
  trying not to run.
- `packages/hub/src/remote/join-script.ts:515` — the PowerShell equivalent.
  Note the `Remove-Item -Recurse -Force` there already has a failure path for
  a file held open by something else; keeping `node_modules` shrinks that
  surface as well as the runtime.
- `packages/hub/src/remote/deployer.ts:149` — the SSH deploy path, with the
  same `rm -rf hub` followed by the same `npm install` at `:156`.
- `packages/hub/scripts/pack-hub.mjs:70` — where the staging directory is
  assembled. The fingerprint the stamp compares against is cheapest to compute
  here, once at pack time, and ship inside the tarball.
- `packages/hub/test/enroll.test.ts` — where a test that a second join skips
  the install belongs.
