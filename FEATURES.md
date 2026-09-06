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
  Code takes `--model`; Codex takes `--model` and a `-c model_reasoning_effort`
  config override; Gemini takes `--model` and has no effort at all. So a
  template cannot hold argv — it holds *values*, and the agent declares how to
  spell them. The `{{...}}` substitution already used for the MCP config path
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
