# aiCanvas

Run several CLI coding agents at once on one infinite canvas, and let them talk
to each other.

Each terminal window on the canvas runs an agent CLI wired to an MCP server the
hub exposes. Agents can look each other up, send each other messages, spawn
helpers into their workspace, and check on each other's terminals. A message
from one agent is delivered by typing it into the other's terminal, immediately.

Local-first: the hub runs on your machine, binds loopback only, and the UI is a
browser tab. Other machines run the same hub as a daemon and appear on the same
canvas.

## Requirements

- Node 22 or newer
- An agent CLI on your `PATH` — [Claude Code](https://claude.com/claude-code)
  is the profile that ships configured
- macOS, Windows, or Linux

## Getting started

```bash
npm install
npm run build
npm run dev
```

The hub prints a URL with a token. Open it and slide out the **machines**
panel: every machine, the workspaces on it, and the agents in each. Point a
workspace at a folder there, and start an agent in it.

- **Scroll** to pan, **Ctrl/⌘ + scroll** to zoom, **Ctrl/⌘ + 1** to fit,
  **Ctrl/⌘ + 2** to zoom to one terminal
- Below 60% zoom terminals become preview cards — zoom in to interact
- Clicking an agent in the panel brings the canvas to it

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

Start the hub so the other machine can see it, then let that machine come to
you:

```bash
npm run dev -- --listen lan
```

(Or `npm run dev -w @aicanvas/hub -- --listen lan` if you are calling the
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

That installs the hub into `~/.aicanvas` there and connects it back. The machine
appears in the **machines** panel with a node of its own, and a workspace added
under that node runs its agents over there — same addresses, same
`send_message`, same canvas.

The installer works out what is missing before it changes anything:

- **Node 22.** If the machine has none, or an older one, it fetches a private
  copy into `~/.aicanvas/node` — checksum-verified against nodejs.org's own
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
listening. `~/.aicanvas/hub.log` on that machine has the detail.

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

- `--listen` is opt-in and off by default. With it, your hub is reachable on
  that network, and anyone who can load the join page can attach a machine to
  your canvas. Every other route still requires the token.
- Each download carries a single-use key that expires in 15 minutes. Once a
  machine has joined it keeps a durable token in `~/.aicanvas/host-token` and
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

An agent CLI is configuration, not code. Built-ins are `claude` and `shell`
(a plain terminal, no agent wiring). Override or add profiles in
`~/.aicanvas/agents.toml`:

```toml
[my-agent]
command = "my-cli"
args = ["--mcp-config", "{{mcp_config_path}}"]
status = "heuristic"          # or "hooks", for exact turn boundaries
ready_hint = "[$#>%] ?$"      # prompt regex, for the idle indicator
inject = "bracketed"          # bracketed paste, or "raw"
```

## State and restart

SQLite at `~/.aicanvas/state.db` holds everything needed to redraw the canvas
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

- The hub binds `127.0.0.1` only, never a network interface. Remote hubs too.
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

```bash
npm test              # unit + integration, no LLM required
npm run typecheck
npm run dev           # hub with the built UI
npm run dev:web       # vite dev server, expects a hub on :7777
```

The integration tests spawn real PTYs and drive the real MCP endpoint, so
`npm test` genuinely exercises message delivery and cross-host routing.

### Known quirks

- On Windows, node-pty prints `AttachConsole failed` to stderr when killing a
  PTY from a process with no console attached (notably under the test runner).
  It is noise from a helper process and does not affect behaviour.
