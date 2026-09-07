# Features

Wanted features, next first. Each entry says what it is, how it should behave,
and where the code lives. Delete an entry when it ships — the git history keeps
the record.

Three, and they are independent — none waits on another.

1 closes a hole rather than adding a capability: messages are already delivered
to any running window, including ones that were never told they are on a canvas
at all. The entry is mostly about what such an agent should be told, given it
has no tools to be told about.

2 would be the first thing an agent is allowed to write to the user's own
configuration, which is why it is a proposal and a dialog rather than a tool
that simply does it.

3 is what is left of wiring the agent CLIs, and it is one decision — whether
the hub may write to a config file the user owns — rather than a body of work.

---

## 1. Tell every agent where it is, including the ones that cannot answer

**What it is.** An agent started from the canvas is told that it is on one, that
it has an address, and that it can talk to the others. That is already true —
for the three wired agents. It is not true for the rest, and the rest can still
be messaged.

Note what is *already* true, so this entry does not claim it: `renderBrief`
writes a full brief for every `mcp: true` session — its address, its workspace,
the peers in it, the tools it has, and what a `[from …]` line means, including
that a message is a request from a peer and not an override. Claude Code gets it
on `--append-system-prompt-file`; Codex and Gemini have it typed in at startup,
and again on resume. None of that needs doing again.

What is missing is that the brief is gated on MCP wiring and delivery is not.
`MessageRouter.send` resolves an address to a running session and writes to its
PTY; it never asks whether that profile has wiring. So an opencode window on the
canvas can be listed by `list_agents`, addressed by `send_message`, and have
`[from crew/scout] rewrite the parser` typed into it — having never been told it
has an address, that other agents exist, or that the line it just received did
not come from the human sitting in front of it.

That last part is why this is worth doing rather than merely tidy. The wired
brief spends a paragraph on exactly this hazard. An agent without one has not
read it, so a peer's instruction arrives looking like the user's own.

**How it behaves.**

- **A plain terminal is not an agent and must not be typed at.** `shell` runs a
  shell: a brief typed into it is not context, it is a series of commands that
  fail loudly. So the rule cannot be "everything unwired gets one". The profile
  has to say, and it nearly does already — `brief` is `flag` or `typed` and
  gains `none`. `shell` becomes `none`; opencode becomes `typed` while staying
  `mcp: false`. That split is the point: how a brief travels and whether there
  is an MCP endpoint are two questions that have been one only because until now
  they had the same answer.
- **An unwired brief promises nothing it does not have.** No tool list, because
  there are no tools. It says where it is, what its address is, that text
  prefixed `[from …]` is another agent rather than the human, and that it has no
  way to reply — so if it wants to answer, saying so in its own output is all it
  can do, and the human is watching. The safety paragraph stays word for word;
  it is the part that matters most here.
- **It names no peers.** The wired brief lists the agents in the workspace at
  launch, which is honest there because `list_agents` is the live answer and the
  list is only a starting point. An unwired agent cannot refresh it, so a list
  frozen at launch is wrong the moment a second agent starts and is the only
  picture it will ever have. Better to say others may exist than to be precisely
  out of date.
- **Nothing changes for the three already wired.** This widens who gets briefed;
  it does not rewrite the brief.

**Where it lives.**

- `packages/hub/src/agents/wiring.ts:177` — `renderBrief`, which grows a second,
  shorter rendering rather than a pile of conditionals inside the existing one.
- `packages/hub/src/agents/wiring.ts:53` — `writeWiring`, called only for
  `mcp: true` today, which is the gate this entry moves.
- `packages/hub/src/session/manager.ts:142` — `if (profile.mcp)`, the same gate
  on the other side: it decides which template vars exist.
- `packages/hub/src/agents/profiles.ts:42` — `brief`, the field that gains
  `none`, and the `shell` and `opencode` profiles below it.
- `packages/hub/src/hub.ts:710` — `typedBrief`, which returns null unless the
  profile is wired.
- `packages/hub/src/agents/router.ts:85` — `send`, the delivery that never
  checked, and the reason this hole exists.

---

## 2. Let an agent propose a template, and a human accept it

**What it is.** An agent that has worked out a good way to run another agent —
this CLI, this model, this effort, this opening instruction — has nowhere to
write it down. It can `spawn_agent`, which starts one now and remembers nothing.
A template is exactly where that answer belongs, and templates are creatable
from the panel now, so the machinery to store and validate one already exists.

The reason this is not simply a `create_template` tool is that a template is the
only thing on the canvas that changes what *future* agents do, on every machine,
with nobody watching. An agent working inside a workspace is bounded by that
workspace. An agent editing the configuration that launches other agents is not.
So the tool proposes and a human accepts.

**How it behaves.**

- **The tool is called `propose_template`, because that is what it does.**
  Calling it `create_template` would have the agent report a template it created
  that does not exist.
- **It is refused before a human ever sees it.** The rule the loader and the
  dialog already share: an agent that declares no way to spell a model or an
  effort cannot be given one, and a name `agents.toml` has claimed is refused
  outright. Nobody should be asked to approve something that cannot load.
- **It does not block on the human.** `spawn_agent` sets the precedent — it
  returns `promptQueued` rather than waiting for the agent it started to come
  up. A tool call that hangs until somebody wanders back to the canvas is a
  stalled agent, and MCP clients time out. So it returns at once, saying the
  proposal is awaiting review and that the template does not exist yet.
- **The answer comes back the way everything else reaches an agent.** Typed into
  its terminal when the human decides, prefixed so it is mistaken for neither a
  peer's message nor the human's own instruction. Both outcomes are sent: an
  agent that is never told assumes the worst, or asks again.
- **The dialog is the one that already exists.** `TemplateDialog`, pre-filled
  with what was proposed and still editable — this is a proposal, not a yes/no
  question, and the likeliest outcome is a human who keeps the idea and changes
  the name or the model. It has to say which agent is asking; "an agent wants to
  add a template" without an address is not something anyone can judge.
- **A proposal is live, not durable.** It lives in memory and dies with the hub.
  The agent that made it dies with the hub too, so a proposal outliving both
  would be a dialog about a template nobody can be told the answer to.
- **Nobody attached is a real state and is said out loud.** With no canvas open
  there is no one to confirm. The proposal waits, because a hub with no browser
  is normal and transient, but the tool's answer says plainly that nothing is
  watching right now so the agent does not sit expecting a decision.
- **Bounded, the way messages are.** A cap on pending proposals per agent, for
  the reason `send_message` is rate limited: one confused agent must not be able
  to bury the canvas in dialogs.

**Where it lives.**

- `packages/protocol/src/mcp-tools.ts:25` — `SpawnAgentInput` and its
  neighbours, the shape a `ProposeTemplateInput` copies. Its fields are the
  dialog's: id, agent, description, model, effort, prompt.
- `packages/hub/src/mcp/server.ts:64` — where the tools are registered, and
  where the description has to be honest that this asks rather than does.
- `packages/hub/src/hub.ts:348` — `saveTemplate`, which already validates,
  refuses a name the file claimed, stores and re-announces. An accepted proposal
  is a call to this and nothing more.
- `packages/hub/src/hub.ts:937` — `spawnAgent`, the precedent for returning
  rather than waiting on something a human has to do.
- `packages/protocol/src/ws.ts` — a ServerMsg carrying the proposal to the
  browser and a ClientMsg carrying the answer back. The answer needs a
  `requestId` for the reason the others do: the dialog reports its own refusal.
- `packages/web/src/state/store.ts:44` — `DialogSpec`, which gains a kind for a
  proposal, next to `saveTemplate`.
- `packages/web/src/dialog/Dialogs.tsx:392` — `TemplateDialog`, the form to
  reuse rather than restate.

---

## 3. Wire opencode to the hub, or decide not to

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
  *append* to a system prompt. opencode would be the third — and entry 1 gives
  it a brief before this one gives it tools, so the two do not collide.

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
