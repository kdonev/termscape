# Features

Wanted features, next first. Each entry says what it is, how it should behave,
and where the code lives. Delete an entry when it ships — the git history keeps
the record.

Two, and they are independent — neither waits on the other.

1 is UI over machinery that already exists: templates are already offered,
already validated, already recorded on the sessions that used them. What is
missing is making one without a text editor. It carries one real decision,
about where a template written from the UI is stored, and that decision is
argued out in the entry rather than left to whoever picks it up.

2 needs a machine with Codex and Gemini actually installed on it. Nothing about
those two should be written down from memory: both of the CLIs that *were*
installed differed from what had been assumed of them.

---

## 1. Templates as their own root in the panel

**What it is.** Templates exist and the picker offers them, but the only way to
make one is to hand-edit `~/.termscape/agents.toml` and restart the hub. That
is a strange gap: every other thing on the canvas — machines, workspaces,
agents — is created from the panel, and the one piece of pure configuration is
the one you have to find a text editor for. Templates should be a root in the
tree next to the machines, where you set them up once and then pick them when
starting an agent.

Note what is *already* true, so this entry does not claim it: the picker
already lists templates, already refuses one that does not load, and a session
already records what its template resolved to. What is missing is only the
making and editing of them.

**How it behaves.**

- **A second root, not a branch.** The existing roots are machines, and their
  children are locations: this machine, the workspaces on it, the agents in
  each. A template is not in a location — it is config, and one template is
  used on every machine. So it sits beside the machines rather than under one.
- **The panel is called "machines".** With two roots that title is wrong. It is
  a one-word change and it is the honest signal that this entry changes what
  the panel *is*.
- **Machines first, templates below, collapsed.** Machines are what you work in
  every day; templates are what you set up once and then forget. Opening the
  panel to reach a terminal should not mean scrolling past a list of templates.
- **The rows are the ones already designed.** `+ template` on the root, `edit`
  and `×` on each — the same three controls a workspace row has, opening the
  same dialog component. A template is four fields, one of them multi-line,
  which is exactly the shape the dialog was built for.
- **Availability is per machine, and a template cannot claim it.** A template
  names an agent; whether that agent is installed is each machine's own answer.
  So the row cannot say "available" — it can say which machines have its agent,
  or say nothing and leave that to the picker, which already knows because it
  joins the two lists. Saying nothing is probably right: a template row that
  goes red because one of four machines lacks a CLI is noise.
- **The built-in bare templates are not editable.** Every agent gets a template
  under its own name for free, which is what keeps `claude` and `shell` working.
  Those are derived, not stored, so *editing* one has to mean creating a stored
  template that shadows it — or they are shown differently and only offered as
  a starting point for a new one. Worth deciding before the tree is written,
  because it decides whether a row has an `edit` button at all.
- **Validation happens in the dialog, on the values, before saving.** The rule
  already exists and already runs at load: an agent that declares no way to
  spell a model or an effort cannot be given one. In a dialog it can do better
  than report it — the effort field simply should not be there for an agent
  with no effort setting, the way the start-an-agent dialog already hides it.
- **Editing a template does not disturb what is running.** A session records
  what its template resolved to precisely so resume cannot drift, so an edit
  affects the next agent started and nothing else. Removing a template is the
  same: the sessions it started keep their model and effort and their ability
  to resume. Both of those are already true and neither needs a confirmation
  that pretends otherwise.

**Where it lives, and the one real decision.**

Templates are loaded from a file the user owns and are held read-only. Creating
them from the UI means writing, and there are two ways:

- **Round-trip `agents.toml`.** Keeps one source of truth and keeps templates
  next to the agents they name. But it means rewriting a file a person edits by
  hand, and a formatter that eats their comments and ordering the first time
  they use the dialog is a bad trade for a config file.
- **Store them in `state.db` and treat `agents.toml` as a second, read-only
  source.** Matches how workspaces and hosts already work, needs no TOML
  writer, and cannot damage anything the user typed. The cost is two places to
  look, and a rule for which wins when both declare the same id.

The second is almost certainly right, and the rule should be that the file wins
— someone who wrote a template by hand meant it, and a UI silently overriding
their file is worse than a UI refusing an id the file has claimed.

- `packages/web/src/panel/Panel.tsx:37` — `buildTree(...)` and the `panel-body`
  below it, which maps machines and nothing else. This is where a second root
  is rendered.
- `packages/web/src/panel/Panel.tsx:42` — `panel-title`, the word "machines".
- `packages/web/src/panel/Panel.tsx:189` — `WorkspaceNode`, the row shape to
  copy: label, sub, `+`, `edit`, `×`.
- `packages/web/src/state/tree.ts:61` — `buildTree`, which returns
  `TreeMachine[]`. Templates are not machines, so either this grows a second
  return or the panel composes two lists.
- `packages/hub/src/agents/templates.ts:94` — `TemplateRegistry.load`, which
  currently reads only the file. It gains the stored set and the precedence
  rule.
- `packages/hub/src/agents/templates.ts:64` — `validate`, already the single
  place that decides whether a template is usable. The dialog should call the
  same rule rather than restate it.
- `packages/hub/src/agents/templates.ts:52` — `bare`, which mints a template
  per agent. Whatever is decided about editing built-ins is decided here.
- `packages/hub/src/db/migrations.ts:170` — migration 5 is the latest; a stored
  template table would be 6.
- `packages/protocol/src/ws.ts:85` — `createWorkspace` and the `updateWorkspace`
  beside it, the shape for `createTemplate` / `updateTemplate` /
  `removeTemplate`. They carry `requestId`, so the dialog gets its refusal in
  the dialog; add them to `AckableMsg` at `:173` or `request()` will not accept
  them.
- `packages/protocol/src/ws.ts:205` — `HubState.templates`, which is the whole
  list today. A change needs pushing too: `templateUpserted` and
  `templateRemoved`, next to the workspace ones.
- `packages/web/src/dialog/Dialogs.tsx:207` — `StartAgentDialog`, which already
  offers templates, already hides the effort field for an agent without one,
  and is most of the form a template dialog needs.

---

## 2. Wire Codex, Gemini and opencode to the hub's MCP endpoint

**What it is.** Detection finds all four agents and the panel shows what each
machine has, but only `claude` is an *agent* on the canvas. The other three are
built-in profiles with `mcp: false` — a terminal running that CLI, with no
address, no brief, and no `send_message`. That is honest rather than desirable:
each configures MCP its own way, and a profile claiming wiring it does not have
is worse than one that says plainly it is a terminal.

**What is known.**

- **opencode** has no `--mcp-config <file>` equivalent. `opencode mcp add`
  mutates its own config, and its `--help` lists no per-run config flag. Wiring
  it therefore means writing to config the user owns, which needs a decision
  about where and whether to clean up — not just a profile entry. Verified
  against opencode 1.1.51.
- **Codex CLI** and **Gemini CLI** were not installed on the machine this was
  written on, so nothing about them is verified. Establish that first. The same
  trip settles their `model_args` and `effort_args`, which templates already
  support and which these two currently declare as absent — so a template can
  name them and nothing else, and asking one for a model is refused at load.

**How it behaves.**

- **Whatever is written, is written back.** If wiring an agent means editing a
  config file the user owns, removing the agent has to undo it, and a hub that
  was killed rather than stopped must not leave the file pointing at a port
  nothing is listening on.
- **A profile says which it is.** `mcp: true` is a promise that the agent gets
  an address and can be messaged; nothing should set it before that is true on
  the machine in front of you.
- **The brief has to arrive somehow.** Claude Code takes
  `--append-system-prompt-file`; an agent with no equivalent needs its brief
  typed in at startup, which is the same wait `spawn_agent` already uses.

**Where it lives.**

- `packages/hub/src/agents/profiles.ts` — `BUILTIN_PROFILES`, where the three
  currently sit as `mcp: false` with a description saying so.
- `packages/hub/src/agents/wiring.ts` — how a session's MCP config, settings
  and brief are generated for Claude Code today.
- `README.md`, "Agent profiles" — which states plainly that only `claude` is
  wired, and is the sentence this entry would rewrite.
