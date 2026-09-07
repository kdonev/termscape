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

2 is what is left of wiring the other agent CLIs, now that Codex and Gemini are
done. It is smaller than it looks and it is mostly one decision — whether the
hub may write to a config file the user owns — because opencode, unlike the
other two, offers no way in that lasts only for one run.

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

## 2. Wire opencode to the hub, or decide not to

**What it is.** Codex and Gemini are wired now, and the way they got there says
what is left. Both had a per-run route into their MCP config — Codex takes
`-c mcp_servers.termscape.url=…` on any invocation, Gemini has
`GEMINI_CLI_SYSTEM_SETTINGS_PATH` — so neither needed a byte written to a file
the user owns, and there is nothing to undo when a session ends or when the hub
is killed rather than stopped.

opencode has neither. `opencode mcp add` mutates its own config and its
`--help` lists no per-run equivalent, verified against opencode 1.1.51. So
wiring it is not a profile entry; it is a decision about writing to somebody
else's file and cleaning up afterwards even when the hub did not exit cleanly.
That decision is the entry.

**How it behaves, if it is done.**

- **Whatever is written, is written back.** A hub that was killed rather than
  stopped must not leave `opencode.json` pointing at a port nothing is
  listening on. That means the cleanup cannot live only in a shutdown path —
  it has to be something the next hub start can finish on the dead one's
  behalf.
- **A profile says which it is.** `mcp: false` is the honest answer today.
  Nothing should set it true before the wiring is real on the machine in front
  of you.
- **The brief arrives the way Codex's and Gemini's do.** That machinery exists
  now: a profile marked `brief: 'typed'` has its brief typed in once the CLI is
  up, ahead of the opening instruction, because neither of those two can
  *append* to a system prompt. opencode would be the third.

**What was settled, so it is not re-litigated.**

- Codex is not resumable and Gemini is not either — Codex mints a session id it
  will not accept from us, and Gemini accepts one via `--session-id` but
  resumes by list index rather than by that id. Both restart clean, and the
  hub types their brief again when they do.
- Codex's bearer token goes in the environment, named by
  `bearer_token_env_var`, never in `-c`: config overrides land in the command
  line where any other user on the machine can read them.
- Gemini refuses to start MCP servers in an untrusted folder and reports it as
  a warning, so the agent comes up looking fine with no tools. `--skip-trust`
  is the answer and it writes nothing; disabling folder trust in the settings
  file would have been the wrong one.

**Where it lives.**

- `packages/hub/src/agents/profiles.ts` — `BUILTIN_PROFILES.opencode`, still
  `mcp: false` with a description saying so.
- `packages/hub/src/agents/wiring.ts` — what is generated per session, and
  where an opencode config would be written from.
- `README.md`, "Agent profiles" — the table of how each agent reaches the hub,
  which is the paragraph this entry would extend.
