# aiCanvas

Run several CLI coding agents at once on one infinite canvas, and let them talk
to each other.

Each terminal window on the canvas runs an agent CLI wired to an MCP server the
hub exposes. Agents can look each other up, send each other messages, spawn
helpers into their workspace, and check on each other's terminals. A message
from one agent is delivered by typing it into the other's terminal, immediately.

Local-first: the hub runs on your machine, binds loopback only, and the UI is a
browser tab. Remote machines run the same hub as a daemon reached over SSH.

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

The hub prints a URL with a token. Open it, point a workspace at a folder, and
start an agent in it.

- **Scroll** to pan, **Ctrl/⌘ + scroll** to zoom, **Ctrl/⌘ + 1** to fit
- Below 60% zoom terminals become preview cards — zoom in to interact

## How it fits together

```
Browser (canvas, xterm.js)
   │  WebSocket: JSON control + binary PTY frames
Hub (Node)
   │  node-pty ── agent CLI processes
   │  MCP over HTTP ── the tools agents call
   │  SQLite ── workspaces, layout, sessions, screens
   │  SSH tunnel
Remote hub (same binary, --headless)
```

Agents never talk to each other directly. They call `send_message` on their own
hub; the hub does the delivery, locally or by forwarding to a peer. That is why
an agent addresses a peer on another machine exactly as it addresses one in the
next window.

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

Add a host in the UI. The hub is copied over SSH, installed, and started as a
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
