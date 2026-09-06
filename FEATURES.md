# Features

Wanted features, next first. Each entry says what it is, how it should behave,
and where the code lives. Delete an entry when it ships — the git history keeps
the record.

Templates lead because detection now feeds them: the model list is real, and
what a template still needs is the *spelling* of each agent's model and effort
flags. Two of the four remain unverified, and entry 2 is what would establish
them — so an agent whose flags nobody has checked gets a template that names it
and nothing else, which is exactly today's behaviour and is fine.

---

## 1. Agent templates: which agent, which model, how much effort, and a first instruction

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
  (see the table below for what is verified and what is not). So a template
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

**What is verified about the four.** Re-checked on this machine against the
CLIs that are installed; do not take the unverified rows from memory, because
both of the ones that *were* installed differed from what had been assumed.

| | model flag | effort flag | list models |
|---|---|---|---|
| Claude Code 2.1.263 | `--model` — aliases `fable`, `opus`, `sonnet`, or a full name like `claude-fable-5` | `--effort <level>` — `low`, `medium`, `high`, `xhigh`, `max` | none; the aliases are declared in the profile instead |
| opencode 1.1.51 | `run -m provider/model` | `run --variant` (high, max, minimal) | `opencode models`, 395 lines |
| Codex CLI | not verified | not verified | not verified |
| Gemini CLI | not verified | not verified | not verified |

Detection already carries the model list, so the picker knows what each agent
offers. What it does not carry is how to *spell* a chosen model or effort on
the command line, which is the row above and the work here.

**Where it lives.**

- `packages/hub/src/agents/profiles.ts` — `AgentProfile`, which already
  declares `versionArgs`, `modelsArgs` and `models` for detection. The model
  and effort *argument fragments* would sit beside them, alongside the argv it
  already declares.
- `packages/hub/src/agents/detect.ts` — where the model list comes from, and
  what a template's model should be validated against.
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
- `packages/web/src/dialog/Dialogs.tsx:193` — `StartAgentDialog`, the profile
  select. It has room for a model, an effort and a multi-line instruction now,
  which is what it did not have in the tree.
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
  written on, so nothing about them is verified. Establish that first.

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
