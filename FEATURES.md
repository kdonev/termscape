# Features

Wanted features, next first. Each entry says what it is, how it should behave,
and where the code lives. Delete an entry when it ships — the git history keeps
the record.

One, and it is mostly a single decision rather than a body of work: whether the
hub may write to a config file the user owns. Codex and Gemini are wired and
neither needed that, because each has a way in that lasts only for one run.
opencode has neither, which is the whole of what is left.

---

## 1. Wire opencode to the hub, or decide not to

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
