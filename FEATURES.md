# Features

Wanted features, next first. Each entry says what it is, how it should behave,
and where the code lives. Delete an entry when it ships — the git history keeps
the record.

---

## 1. Clicking the canvas closes the side panel

**What it is.** The machines panel slides over the right of the canvas and only
closes from its own `›` button or the toolbar. Reaching for either is a
detour when the thing you actually want is the canvas you can already see.
Clicking the canvas should close it.

**How it behaves.**

- **Any pointer down inside the canvas closes it**, whether it lands on empty
  canvas or on a terminal window. Both mean the same thing: you are done with
  the list and back on the canvas.
- **Nothing inside the panel closes it.** Adding a workspace, starting an
  agent, expanding a node — all of that is panel work, and the panel is a
  sibling of the canvas rather than a child, so those clicks never reach it.
- **Clicking an agent row is the exception worth thinking about.** It moves the
  canvas to that window, and the click is on the panel, so the panel stays
  open — which is right when you are working down a list of agents, and wrong
  if you meant to go there and get on with it. Leave it open, since the canvas
  is one click away from closing it anyway.
- **Escape should close it too**, before it clears the selection, so the key
  unwinds one thing at a time.

**Where it lives.**

- `packages/web/src/canvas/Canvas.tsx:211` — `onPointerDown` on `.canvas`. Note
  its second line returns early unless the event landed on the canvas itself,
  which is what stops a click on a window from starting a pan. The close
  belongs *above* that guard: pointer events from a window bubble up to this
  element, so one line there covers both cases and no change to
  `window/TerminalWindow.tsx` is needed.
- `packages/web/src/state/store.ts:210` — `setPanelOpen`. Worth guarding on the
  current value rather than writing `false` on every canvas click: each write
  is a new store object and a re-render for everything subscribed to it, and
  most canvas clicks happen with the panel already shut.
- `packages/web/src/canvas/Canvas.tsx:600` — the Escape branch, if that half is
  taken as well. It currently clears the selection unconditionally; it would
  need to close the panel first and clear the selection only when the panel was
  already closed.
- `packages/web/src/panel/Panel.tsx:44` — the `›` button, which stays as the
  deliberate way to close it.

---

## 2. Agent templates: which agent, which model, how much effort, and a first instruction

**What it is.** Starting an agent asks one question — which CLI — and nothing
else. Everything that actually distinguishes one agent from another is missing:
the model, how hard it is told to think, and what you want it to do. A template
is a saved answer to all four, picked once instead of typed every time.

    [template.reviewer]
    agent  = "claude"
    model  = "opus"
    effort = "high"
    prompt = "Review the diff on this branch for correctness bugs. Report, do not fix."

    [template.scout]
    agent  = "codex"
    model  = "gpt-5-codex"
    effort = "low"
    prompt = "Find where X is implemented and summarise. Read only."

**A word on words first, because this entry cannot be written without it.** The
CLIs — Claude Code, Codex CLI, Gemini CLI — are what we call agents. The code
calls them *profiles* (`AgentProfile`, `agents.toml`, and the picker lists
profile ids) and calls a *running* one an agent too. Two things are wearing the
same word. Proposed, and worth settling before any of this is built:

- **agent** — the CLI program. What `agents.toml` configures. Today's profile.
- **template** — an agent plus a model, an effort and an opening instruction.
  The thing a human picks from a list.
- **session** — one running instance, with an address and a window. Unchanged.

Under that reading `profile` stops being a user-facing word and stays what it
is internally: the recipe for launching one CLI.

**How it behaves.**

- **The picker offers templates, not CLIs.** A template that names only an
  agent and nothing else is exactly today's behaviour, so `claude` and `shell`
  survive as trivial templates and nothing that works now stops working.
- **Model and effort are per-agent flags, and this is the hard part.** Claude
  Code takes `--model` and `--effort`; opencode takes `run -m provider/model`
  and calls effort `--variant`; Codex and Gemini spell both differently again
  (see entry 3, which has what is verified and what is not). So a template
  cannot hold argv — it holds *values*, and the agent declares how to spell
  them. The `{{...}}` substitution already used for the MCP config path
  is the mechanism; what is new is that a fragment has to disappear entirely
  when a template leaves it unset, rather than expand to an empty string.
- **An agent that has no effort setting says so**, and a template asking for
  one on that agent is a configuration error worth reporting at load, not a
  flag silently dropped at launch.
- **The first instruction is typed in once the CLI is up**, not at launch:
  written into argv it would be a different thing entirely, and written
  immediately it lands before the program is reading. That wait already exists
  for `spawn_agent`.
- **A resumed session keeps its template.** Resume deliberately rebuilds argv
  rather than replaying it, so the model and effort have to be recorded on the
  session or they are quietly lost the first time a machine restarts — and an
  agent coming back on a different model than it left with is worse than one
  that does not come back.
- **The opening instruction does not repeat on resume.** It is how the session
  started, not what it is.

**Where it lives.**

- `packages/hub/src/agents/profiles.ts:11` — `AgentProfile`. Where an agent
  would declare its model and effort argument fragments, alongside the argv it
  already declares.
- `packages/hub/src/agents/profiles.ts:149` — `template()` and `templateAll()`,
  the substitution to extend.
- `packages/hub/src/agents/profiles.ts:98` — `ProfileRegistry.load` and
  `~/.termscape/agents.toml`. Templates want to live beside the agents they
  name; note this loader deliberately survives a broken file by falling back to
  built-ins, and templates should fail the same way.
- `packages/protocol/src/ws.ts:78` — `startSession` carries `profile`. It would
  carry a template, and `packages/protocol/src/domain.ts:120`
  (`AgentProfileInfo`) is what the browser is given to build the picker from.
- `packages/web/src/panel/Panel.tsx:328` — `StartAgent`, the profile select in
  the tree panel.
- `packages/hub/src/hub.ts:618` — `deliverInitialPrompt`, the readiness wait to
  reuse. It prefixes `[from <address>]`, which is right for a message from a
  peer and wrong for an instruction from the human — that needs a path that
  types the text plainly.
- `packages/hub/src/session/manager.ts:224` — the resume rebuild, and why the
  template's values have to be persisted on the session.
- `packages/hub/src/remote/registry.ts:356` — starting an agent on another
  machine sends a profile *id* and the peer resolves it against its own config.
  A template has to either resolve to concrete values before it crosses, or
  exist on both machines. The first is the smaller change and the only one that
  works when the two machines have different config.

---

## 3. Find the agents already installed, and the models they offer

**What it is.** The picker offers whatever `agents.toml` declares, and only
`claude` and `shell` are built in. A machine usually has more than that on its
PATH already. Find them, and find out what models each one can be pointed at,
so a template is chosen from a real list rather than typed from memory.

First four to support: **Claude Code**, **Codex CLI**, **Gemini CLI** and
**opencode**.

**How it behaves.**

- **Each machine probes its own PATH.** `which()` already does this, on both
  platforms, including the Windows `.cmd`/`.bat` shims that npm installs.
  Nothing here needs a new mechanism.
- **Per machine, and that is the point.** A host has its own PATH, and this
  hub's answer says nothing about it. Today, starting an agent on a workspace
  that lives on another machine sends a profile *id* which that machine
  resolves against its own config, so an agent it does not have fails at
  launch with a spawn error. The detected set has to cross the peer link, and
  the panel should show, per machine, what that machine actually has.
- **A declared agent that is not installed stays visible and says why.** It
  should read as unavailable, with the command that was not found — not
  silently vanish, which looks like the config was ignored.
- **Models: ask where you can, declare where you cannot.** This is not uniform,
  and the design has to carry both. Verified here:
  - `opencode models` prints one `provider/model` per line — 395 of them on
    this machine. Real enumeration.
  - Claude Code has no listing command. `--help` documents the aliases
    (`fable`, `opus`, `sonnet`) and says a full name like `claude-fable-5` is
    also accepted.

  So an agent declares an optional command whose stdout is one model per line,
  and a static list is the fallback for the ones that cannot answer.
- **Cache it.** Spawning a process and parsing 395 lines is not something to do
  while someone opens a dropdown. Refresh on demand, and when the agent's
  version changes — `claude --version` prints `2.1.263 (Claude Code)`, which is
  both worth showing and a good cache key.
- **Detection never blocks startup.** A CLI that hangs on `--version` must cost
  a slow dropdown, not a hub that will not boot.

**What is already known about the four.** Verified on this machine:

| | model flag | effort flag | list models |
|---|---|---|---|
| Claude Code | `--model` (alias or full name) | `--effort <level>` | none |
| opencode | `run -m provider/model` | `run --variant` (high, max, minimal) | `opencode models` |
| Codex CLI | not verified | not verified | not verified |
| Gemini CLI | not verified | not verified | not verified |

Codex and Gemini were not installed here, so their rows are the first thing to
establish on a machine that has them. Do not take them from memory: the two
that *were* installed both differed from what the previous entry assumed.

**Where it lives.**

- `packages/hub/src/agents/resolve.ts:30` — `which()`. The whole detection
  primitive, already written.
- `packages/hub/src/agents/profiles.ts:42` — `BUILTIN_PROFILES`. Needs entries
  for codex, gemini and opencode, each with its own MCP wiring: opencode's
  default command is a TUI and it has its own `mcp` subcommand, so none of this
  is a copy of the claude profile.
- `packages/protocol/src/domain.ts:120` — `AgentProfileInfo`, what the browser
  is given. Gains availability, version and the model list.
- `packages/hub/src/remote/peer-serve.ts` and `remote/registry.ts` — the
  detected set has to travel, the way sessions already do.
- `packages/web/src/panel/Panel.tsx:328` — the picker, which becomes per
  machine rather than one global list.

---

## 4. Add and edit in a dialog, not in the tree

**What it is.** Adding a workspace, starting an agent and attaching a machine
all open a small form *inside* the tree, in a 420px panel. The fields wrap, the
tree jumps as the form appears, and everything below the node you clicked
slides down the page. A dialog over the canvas is the right shape for this: it
has room, it does not disturb what is behind it, and it is where editing can
live at all.

**How it behaves.**

- **One dialog component, three uses to start**: add a workspace, start an
  agent, attach a machine. Each opens over the canvas with the panel still
  visible behind it, so you can see the node you acted on.
- **Editing becomes possible.** There is nowhere to rename a workspace or fix a
  host's ssh details today, because there is nowhere to put the form. Once the
  dialog exists, an *edit* on a node is the same dialog opened with values in
  it, and that is most of the work of adding editing at all.
- **This is what makes entry 2 fit.** A template is an agent, a model, an
  effort and an opening instruction — four fields, one of them multi-line.
  There is no version of that which belongs inline in a 420px column, so the
  dialog is a prerequisite rather than a polish item.
- **Standard dialog behaviour, all of it**: focus moves into the first field on
  open and is trapped while it is there; Escape closes; clicking the backdrop
  closes; Enter submits from any single-line field; focus returns to the
  control that opened it. Anything less and it is a div, not a dialog.
- **Validation belongs in the dialog**, next to the field, rather than arriving
  later as a red toast in the corner from the hub. A folder path that does not
  exist is the common case and the hub already reports it.
- **Removals should match.** They use `window.confirm` today — a native dialog
  that looks like nothing else in the app and cannot say what it is about to
  take with it in any useful way. Worth moving to the same component, so
  destructive confirmations and edits look like one system.

**Where it lives.**

- `packages/web/src/panel/Panel.tsx:280` — `AddWorkspace`, and `:328`
  `StartAgent`. Both are `.node-form` blocks rendered as children of the node
  they belong to; both become a dialog opened from that node.
- `packages/web/src/AddMachine.tsx:12` — the attach-a-machine panel, the
  biggest of the three: two tabs, five fields in the ssh form, and a paragraph
  of explanation, all inside the same narrow column.
- `packages/web/src/panel/Panel.tsx:115`, `:193`, `:264` — the three
  `window.confirm` calls, if destructive confirmations move too.
- `packages/web/src/styles.css:381` — `.node-form`, which goes away, and where
  the dialog and backdrop rules would sit.
- `packages/web/src/state/store.ts` — the panel already keeps its open state in
  the store rather than in the component. A dialog that can be opened from a
  node, from the canvas or from a keyboard shortcut wants the same treatment.
- Use the native `<dialog>` element rather than a div with a high z-index: it
  gives the backdrop, the focus trap and Escape without writing any of them,
  and `showModal()` is supported everywhere this app runs.

---

## 5. Reach the canvas from another machine without being told to

**What it is.** The hub binds loopback and nothing else unless you pass
`--listen lan`. That is one flag more than most people will find: the canvas is
worth opening on a second screen or a phone, and attaching a second machine is
the feature the join page exists for, and neither is discoverable from a hub
that only ever prints `127.0.0.1`. Running the package should bind so other
machines can reach it, and loopback should keep working exactly as it does now.

Say plainly what this trades. Today a fresh install is reachable by nothing but
the browser on the same machine, and going wider is a decision someone makes on
purpose. Afterwards every install is on the network by default, and the join
page — the one route that is deliberately unauthenticated, so it can be typed
by hand — answers anyone who can reach the port. That is a real change in what
a default install exposes, on a laptop that moves between a home network and a
café. It should be taken deliberately or not at all.

**How it behaves.**

- **The bind widens; the token does not move.** `--listen lan` already resolves
  to `0.0.0.0` rather than the LAN address alone, precisely so loopback keeps
  answering — the browser opens the canvas there and every agent's generated
  MCP config points there. Making it the default changes which interfaces
  answer and nothing else. The canvas, the WebSocket and `/mcp` still require
  the client token.
- **A machine with no LAN address must still start.** `resolveBindHost`
  (`packages/hub/src/remote/lan.ts:38`) throws when there is no non-loopback
  IPv4 address, which is right for a flag someone typed and wrong for a
  default. As a default it has to fall back to loopback quietly.
- **`--listen loopback` becomes the way back.** There is currently no spelling
  for "narrower than the default", because the default was the narrowest thing
  there was. It needs one, and `--listen 127.0.0.1` already works — it just has
  to be documented as the opt-out rather than as an oddity.
- **The startup banner has to lead with the consequence.** It already prints
  the enroll URL and a "reachable from your network" note when bound wide, but
  that reads as confirmation of something you asked for. As a default it is
  news, and should be the first thing said, not the last.
- **Worth pairing with a narrower join page.** The enrollment token is already
  single-use and expires in fifteen minutes
  (`packages/hub/src/remote/enroll.ts:29`), but the page that hands one out is
  reachable by anyone who can reach the port. If the hub is on the network by
  default, that page should probably be off until asked for — which would make
  this change "reachable by default, enrollable on request" rather than both.

**Where it lives.**

- `packages/hub/src/cli.ts:91` — `values.listen ? resolveBindHost(values.listen)
  : undefined`, where `undefined` currently means loopback. This is the line
  that changes.
- `packages/hub/src/remote/lan.ts:38` — `resolveBindHost`, and the comment above
  it explaining why `lan` binds the wildcard. It needs a non-throwing path for
  the default case.
- `packages/hub/src/cli.ts:43,65` — the `listen` option and its help text, which
  has to describe the default and the way out of it.
- `packages/hub/src/cli.ts:106-121` — the banner, including the existing
  `enroll:` and "reachable from your network" lines.
- `packages/hub/src/server.ts:34` — `ServeOptions.host`, and `advertisedHost` /
  `coversLoopback` around it, which already do the right thing for a wide bind
  and should need no change.
- `README.md` — the requirements and the "Adding another machine" section, which
  currently states that `--listen` is opt-in and off by default. That sentence
  is the promise being reversed, so it is the one to rewrite first.
- `packages/hub/test/enroll.test.ts:101` — the `bind address` block, which
  asserts today's behaviour directly: `advertisedHost('127.0.0.1')` is null and
  `servedA.enrollOrigin` is null. Those expectations encode the old default and
  are the honest measure of whether this landed.
