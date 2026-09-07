# Termscape

Run a crew of AI coding agents on one infinite canvas, and let them talk to
each other.

Each terminal window on the canvas runs an agent CLI wired to an MCP server the
hub exposes. Agents can look each other up, send each other messages, spawn
helpers into their workspace, and check on each other's terminals. A message
from one agent is delivered by typing it into the other's terminal, immediately.

Local-first: the hub runs on your machine and the UI is a browser tab. It binds
every interface, so the canvas opens on your phone or a second screen as well —
with its token; `--listen loopback` keeps it to this machine. Other machines run
the same hub as a daemon and appear on the same canvas.

## Getting started

```bash
npx @kdonev/termscape
```

That starts the hub and opens the canvas in your browser — pass `--no-open`
if you would rather it did not; the URL is printed either way. Nothing is
installed system-wide: state lives in `~/.termscape`, and deleting that
directory is the uninstall.

The hub is reachable from your network, so the same URL — token and all — opens
the canvas on a phone or a second screen. Attaching another machine is a
separate opt-in; see [Adding another machine](#adding-another-machine). To keep
the hub to this machine entirely:

```bash
npx @kdonev/termscape --listen loopback
```

Slide out the **machines** panel: every machine, the workspaces on it, and
the agents in each. Point a workspace at a folder there, and start an agent
in it. Adding, editing and removing all open a dialog over the canvas, so the
node you acted on stays where it was and a refusal — a folder that is not
there, a rename the addresses will not allow — arrives in the dialog next to
the field, with what you typed still in it.

- **Scroll** to pan, **Ctrl/⌘ + scroll** to zoom, **Ctrl/⌘ + 1** to fit,
  **Ctrl/⌘ + 2** to zoom to one terminal
- A **quick flick** of the zoom — a fast pinch, or a fast spin of the wheel —
  navigates instead of zooming: in over a terminal maximizes it, out steps
  back to the workspace around it and then to everything. Zooming at any
  ordinary pace is left alone
- Below 60% zoom terminals become preview cards — zoom in to interact
- Clicking an agent in the panel brings the canvas to it
- Clicking the canvas closes the panel, as does **Escape** — which closes the
  panel first and clears the selection only once it is shut

## Requirements

- Node 22 or newer
- An agent CLI on your `PATH` — [Claude Code](https://claude.com/claude-code)
  is the profile that ships configured
- macOS, Windows, or Linux

Everything native is prebuilt on all three platforms, so no compiler is
needed.

## How it fits together

```
Browser (canvas, xterm.js)
   │  WebSocket: JSON control + binary PTY frames
Hub (Node)
   │  node-pty ── agent CLI processes
   │  MCP over HTTP ── the tools agents call
   │  SQLite ── workspaces, layout, sessions, screens
   │  hub↔hub WebSocket, either direction
Remote hub (same binary, --headless)
```

Agents never talk to each other directly. They call `send_message` on their own
hub; the hub does the delivery, locally or by forwarding to a peer. That is why
an agent addresses a peer on another machine exactly as it addresses one in the
next window.

## Adding another machine

The hub is already reachable from your network, but it does not hand out join
links until asked. `/join` is the one page served without your token — it has
to be typed by hand on a machine that has nothing yet — so being reachable and
being enrollable are kept as two separate permissions. Turn the second one on,
then let the other machine come to you:

```bash
npx @kdonev/termscape --listen lan
```

(From a clone that is `npm run dev -- --listen lan`, or
`npm run dev -w @termscape/hub -- --listen lan` if you are calling the
workspace directly — npm needs the `--` to hand flags to the hub rather than
reading them itself.)

The hub prints an `enroll:` URL alongside the usual one. Open it **on the
machine you want to add** and run the command it shows:

```bash
curl -fsSL http://studio:7777/join.sh | sh    # macOS, Linux
irm http://studio:7777/join.ps1 | iex         # Windows
```

Both halves of that URL are chosen to be typeable, because the join page is the
one address you have to carry to another machine and enter by hand:

- **The host** is this machine's own name when that name actually resolves to
  the address the hub bound — checked, not assumed. Windows resolves bare names
  over LLMNR/NetBIOS and macOS/Linux over mDNS, and neither is guaranteed, so
  the hub prints the numeric URL underneath as a fallback and the machines
  panel offers it too. The canvas itself is reachable by name as well, token and all,
  which is how you open it on a second screen or a phone.
- **The port** is the first free one from `7777, 4242, 7333, 3333, ...`.
  `--port <n>` overrides it; `--port 0` takes whatever the OS hands out.

That installs the hub into `~/.termscape` there and connects it back. The machine
appears in the **machines** panel with a node of its own, and a workspace added
under that node runs its agents over there — same addresses, same
`send_message`, same canvas.

The installer works out what is missing before it changes anything:

- **Node 22.** If the machine has none, or an older one, it fetches a private
  copy into `~/.termscape/node` — checksum-verified against nodejs.org's own
  `SHASUMS256.txt`, since it is a binary about to be executed. Private rather
  than system-wide, so it needs no administrator rights, no package manager,
  and no fresh shell to pick up a PATH change; uninstalling is deleting the
  directory. A copy already there is reused.
- **Native modules.** It prefers prebuilt binaries for `node-pty` and
  `better-sqlite3`, falls back to compiling, and if neither works tells you
  exactly which toolchain to install.

If the machine does not appear, the installer says why rather than reporting
success: a spent or expired key, a version gap, or a hub that exited. It waits
for the canvas to actually accept the machine, not merely for the hub to start
listening. `~/.termscape/hub.log` on that machine has the detail.

Re-running the join command on a machine that already joined is the supported
way to update or repair it: it stops the hub running there, replaces the
install, and rejoins with the token it already holds — or, if you had removed
that host from the canvas, with the fresh key the command carries. Removing a
machine from the panel stops its hub too, so it is not left running a daemon
that belongs to nobody — and takes the workspaces and agents on it with it,
which the panel says before it does it.

A re-join is quick after the first one: it keeps the dependency tree already
installed there unless the dependencies, the Node version, or the platform
have actually changed, and checks that tree really loads before trusting it.

Two things worth knowing:

- The **join page** is opt-in and off by default; `--listen lan` is what turns
  it on. With it, anyone who can reach your hub can load that page and attach a
  machine to your canvas. Every other route still requires the token, and being
  reachable — which a default install already is — grants none of this.
- Each download carries a single-use key that expires in 15 minutes. Once a
  machine has joined it keeps a durable token in `~/.termscape/host-token` and
  rejoins by itself after a reboot or a dropped link — its agents keep running
  in the meantime.

**If you can't stand at the other machine**, the panel's *deploy over ssh* tab
does the reverse: it connects with your SSH agent or a key, installs the hub
over SFTP, starts it bound to that machine's loopback, and reaches it through a
tunnel. Same protocol, opposite direction.

## Tools agents get

| Tool | What it does |
|---|---|
| `whoami` | your address, workspace and working directory |
| `list_agents` | everyone on the canvas, across every host, and whether they are busy |
| `send_message` | type a message into another agent's terminal, right now |
| `spawn_agent` | start a helper in your workspace, with an optional first task |
| `read_screen` | look at another agent's terminal without interrupting it |
| `set_status` | label your own window so the human can see what you are doing |
| `stop_agent` | stop an agent you spawned |

Every agent is also given a brief explaining its address, its peers, and that
text arriving as `[from <address>] ...` is a colleague rather than the human.

## Agent profiles

An agent CLI is configuration, not code. Built-ins are `claude`, `codex`,
`gemini`, `opencode` and `shell`.

`claude`, `codex` and `gemini` are wired to the hub's MCP endpoint: each gets an
address, a brief and the `send_message` tool set. They arrive there by three
different routes, because no two of these CLIs configure an MCP server the same
way — and none of the three writes to a file you own, so there is nothing left
behind when a session ends or when the hub is killed rather than stopped.

| agent | how it reaches the hub | brief | resume |
| --- | --- | --- | --- |
| `claude` | `--mcp-config` on a generated file | `--append-system-prompt-file` | `--resume <uuid>` |
| `codex` | `-c mcp_servers.…` overrides, one run only | typed in at startup | restarts clean |
| `gemini` | `GEMINI_CLI_SYSTEM_SETTINGS_PATH` at a generated file | typed in at startup | restarts clean |

Codex and Gemini are typed at rather than handed a brief because neither can
*append* to its system prompt — Codex's `base_instructions` and Gemini's
`GEMINI_SYSTEM_MD` each replace the whole thing, which would cost the agent its
own tool instructions. Neither is resumable: Codex mints a session id it will
not accept from us, and Gemini accepts one but resumes by list index instead.

`opencode` and `shell` are plain terminals on the canvas. `opencode mcp add`
mutates its own config and there is no per-run equivalent, so wiring it means
writing to a file you own and undoing that reliably afterwards — a decision that
has not been made rather than one that has been skipped.

Codex's bearer token is passed through the environment, never `-c`: config
overrides land in the command line, where any other user on the machine can
read them.

Override or add profiles in `~/.termscape/agents.toml`:

```toml
[my-agent]
command = "my-cli"
args = ["--mcp-config", "{{mcp_config_path}}"]
status = "heuristic"          # or "hooks", for exact turn boundaries
ready_hint = "[$#>%] ?$"      # prompt regex, for the idle indicator
inject = "bracketed"          # bracketed paste, or "raw"
brief = "typed"               # when it has no flag to append a system prompt
version_args = ["--version"]  # how to ask its version, for the panel
models_args = ["models"]      # optional: one model per line on stdout
models = ["opus", "sonnet"]   # the answer when it has no listing command
model_args = ["--model", "{{model}}"]    # how it spells a model, if it takes one
effort_args = ["--effort", "{{effort}}"] # and an effort
efforts = ["low", "high"]                # the levels it documents
```

### Templates

The picker offers **templates**, not CLIs. A template is an agent plus a model,
an effort and an opening instruction — a saved answer to all four, picked once
instead of typed every time. Every agent gets a bare template under its own
name, so `claude` and `shell` are still there and nothing that worked stops
working.

Templates are a root of their own in the panel, next to the machines — they are
config rather than a place, and one template is used on every machine, so it
does not live under one. **+ template** makes one, `edit` changes it, `×`
removes it. The list sits below the machines and starts collapsed: machines are
what you work in every day, templates are what you set up once and then forget.

They can also be written by hand, and a hand-written one wins:

```toml
[template.reviewer]
agent  = "claude"
model  = "opus"
effort = "high"
prompt = "Review the diff on this branch for correctness bugs. Report, do not fix."
```

- Templates made in the panel are stored in `state.db`, the same place
  workspaces and hosts already live. `agents.toml` is a second, read-only
  source: the hub never writes it, so a formatter cannot eat the comments and
  ordering of a file you edit by hand.
- When both declare the same name **the file wins**, and the dialog refuses the
  name rather than storing a row that would never appear. Someone who wrote a
  template by hand meant it.
- An agent's own bare template is derived, not stored. Editing one makes a
  stored template that shadows it; removing that reveals the bare one again
  rather than leaving a gap.
- Removing a template takes nothing from the agents it already started. They
  keep their model, their effort and their ability to resume, because a session
  records what its template resolved to rather than looking it up again.

Three words, kept apart deliberately: an **agent** is the CLI program, a
**template** is what you pick from the list, and a **session** is one running
instance with an address and a window.

- **A template holds values, not arguments.** Claude Code takes `--model` and
  `--effort`; opencode takes `-m provider/model` and has no effort setting on
  its TUI at all; Codex takes `-m` but spells effort as a config override,
  `-c model_reasoning_effort=…`, because it has no `--effort` flag. So the
  template says *which* model, and the agent declares how to spell it. An agent that declares nothing takes nothing, and a template
  asking for a model or an effort it cannot spell is a configuration error
  reported when the file loads — visible in the dialog, not a flag silently
  dropped at launch.
- **The first instruction is typed in once the CLI is up**, not passed as an
  argument, and it does not repeat when a session is resumed. It is how the
  session started, not what it is.
- **A resumed session comes back on the model it left with.** What the template
  resolved to is recorded on the session, because resume rebuilds the command
  line rather than replaying it — and because a template can be edited
  afterwards.
- **Starting an agent on another machine sends values, not a template name.**
  The two machines do not share config, so the name is resolved here first.

### What is actually installed

Each machine probes its own `PATH` and reports back, so the panel shows, per
machine, which agents are there, what version each is, and the models it
offers. That is per machine on purpose: a host has its own `PATH`, and starting
an agent it does not have used to fail at launch inside a terminal window,
where the error reads like the hub is broken.

- A declared agent that is **not** installed stays in the list, greyed out,
  naming the command that was not found — rather than vanishing, which looks
  like the config was ignored.
- Models are enumerated where the CLI can be asked (`opencode models` returns
  a few hundred) and declared in the profile where it cannot. Claude Code has
  no listing command; its `--help` documents the aliases instead, and it takes
  a full model name as readily as an alias. Codex is declared too, for a
  different reason: `codex debug models` does render the real catalog, but it
  is a debug command answering with half a megabyte of JSON rather than the
  one-per-line stdout the profile reads, so the profile carries the slugs that
  catalog marks visible. In every case a full model name outside the list is
  still accepted — the list is what the dropdown suggests, never a limit.
- Probing runs after the hub is already serving and never blocks it. The first
  page load usually shows *checking…*, and fills in a moment later. **check
  again** in the start-an-agent dialog re-probes every machine.

## State and restart

SQLite at `~/.termscape/state.db` holds everything needed to redraw the canvas
and relaunch every agent. It deliberately does not hold conversation history —
Claude Code already keeps that, and we store the pointer to it.

Kill the hub and start it again: the canvas comes back with its window
positions, its zoom, and each terminal's last screen, with the sessions marked
stopped. **Resume** relaunches an agent with `--resume`, continuing its prior
conversation.

Two consequences worth knowing:

- Only the **last screen** of each terminal survives a restart. Scrollback above
  it is not persisted. (While the hub is running, full scrollback is held in
  memory and replayed when you zoom back into a window.)
- Resume relaunches in the **same working directory**, because that is how
  Claude Code finds a conversation. Move the folder and resume starts fresh.

## Remote machines

Add a machine in the panel. The hub is copied over SSH, installed, and started as a
detached daemon bound to the remote machine's loopback interface, reached only
through an SSH tunnel. Because it is a daemon and not an `ssh` subprocess,
remote agents keep running when the connection drops, and reattach with their
state when it comes back.

The remote host needs Node 22+ and a toolchain able to build `node-pty` and
`better-sqlite3`.

## Security

Agents can type into each other's terminals and spawn more agents. That is the
feature, and it is the risk surface: an agent that reads a hostile repository
could be talked into sending an attacker's text to a peer.

- The hub binds every interface, so the canvas is reachable from your network —
  but only with its token, which is minted per run and never printed anywhere
  the network can read. `--listen loopback` narrows it to this machine.
- A hub running `--headless` — one that joined a canvas, or was deployed over
  ssh and is reached through its tunnel — stays on `127.0.0.1` regardless.
- `/join` is the only route served without the token, and it is off unless you
  passed `--listen lan`.
- Every agent gets its own bearer token. The sender of a message is taken from
  that token, never from the arguments, so attribution cannot be forged.
- Messages are length-capped, rate-limited per sender, and always arrive with a
  visible `[from <address>]` prefix.
- Every delivery attempt is recorded with its outcome and shown in the message
  log. Nothing is delivered invisibly.
- `spawn_agent` is capped per workspace, so a confused agent cannot recurse the
  machine to death.
- An agent may only stop agents it spawned.
- `--dangerously-skip-permissions` is never a default.

## Development

From a clone, rather than the published package:

```bash
git clone https://github.com/kdonev/termscape.git
cd termscape
npm install
npm run build
npm run dev           # hub with the built UI
```

If `npm install` or `npm ci` tries to compile `better-sqlite3` and fails for
want of a C++ toolchain, install this way instead:

```bash
npm ci --ignore-scripts && npm rebuild node-pty
```

Any install that reads `package-lock.json` misses better-sqlite3's
`gypfile: false` and runs `node-gyp` on a module that already ships working
prebuilds. Skipping install scripts avoids that; the rebuild puts back the one
native build that is real, which is a no-op except on Linux. This is what CI
does. It does not affect anyone installing the published package.

```bash
npm test              # unit + integration, no LLM required
npm run typecheck
npm run dev:web       # vite dev server, expects a hub on :7777
```

The integration tests spawn real PTYs and drive the real MCP endpoint, so
`npm test` genuinely exercises message delivery and cross-host routing.

### Known quirks

- On Windows, node-pty prints `AttachConsole failed` to stderr when killing a
  PTY from a process with no console attached (notably under the test runner).
  It is noise from a helper process and does not affect behaviour.

### Releasing

The repo is a workspace of three private packages; what gets published is a
single package assembled by `packages/hub/scripts/pack-npm.mjs` — the hub,
the built UI it serves, and `@termscape/protocol` bundled inside it.

```bash
npm run pack:npm      # build everything, then stage and pack the tarball
```

Tagging `v<version>` runs `.github/workflows/release.yml`, which refuses a
tag that disagrees with `packages/hub/package.json`, installs the packed
tarball on macOS, Windows and Linux and checks each one starts and serves the
canvas, and only then publishes to npm with provenance. Bump the version in
`packages/hub/package.json` **and** `HUB_VERSION` in `packages/hub/src/hub.ts`
together — peer compatibility is gated on the constant, and a test fails if
the two drift.

## License

MIT — see [LICENSE](LICENSE).
