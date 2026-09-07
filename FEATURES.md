# Features

Wanted features, next first. Each entry says what it is, how it should behave,
and where the code lives. Delete an entry when it ships — the git history keeps
the record.

One. It would be the first thing an agent is allowed to write to the user's own
configuration, which is why it is a proposal and a dialog rather than a tool
that simply does it.

---

## 1. Let an agent propose a template, and a human accept it

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
