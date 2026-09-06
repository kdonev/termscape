# Features

Wanted features, next first. Each entry says what it is, how it should behave,
and where the code lives. Delete an entry when it ships — the git history keeps
the record.

One left, and it is the one that needs a machine with the CLIs on it. Codex and
Gemini were not installed where the rest of this was built, and nothing about
them should be written down from memory: both of the CLIs that *were* installed
differed from what had been assumed of them.

---

## 1. Wire Codex, Gemini and opencode to the hub's MCP endpoint

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
