# aiCliCanvas — Implementation Plan

## Context

This repository starts empty. We are building, from scratch, a local-first application for orchestrating CLI coding agents on an infinite canvas.

**The problem:** running several agent CLIs at once today means several disconnected terminal tabs. There is no shared spatial view of what is running where, no way for one agent to hand work to another, and no way to mix local and remote machines in one session.

**The intended outcome:** a browser UI showing one infinite canvas. Terminal windows live on that canvas, grouped by workspace (a local or remote folder). Each window runs an agent CLI wired to an MCP server exposed by the hub, so agents can discover each other, send each other messages, and spawn new agents into their workspace. A message from agent A to agent B is delivered by writing it into B's terminal stdin. Remote workspaces run a hub daemon on the remote host, reached over an SSH tunnel.

**Decisions already made** (from clarification):
- **Stack:** Node 22 + TypeScript hub, React + xterm.js frontend. Portable across macOS / Windows / Linux.
- **Remote:** a hub daemon deployed to the remote host over SSH, not an `ssh` subprocess. Sessions survive disconnects.
- **Agent CLIs:** pluggable profiles; Claude Code is the first real profile, plus a `shell` profile for plain terminals.
- **Message delivery:** inject into the target PTY immediately, always. No queueing, no idle-gating.
- **State:** SQLite is the system of record for everything except conversation history. On restart the canvas is rebuilt from the DB and agents are relaunched with `--resume`. Persisted terminal state is the last screen only — no raw scrollback. One local DB; remote hubs own their own and are not mirrored.

> Note on immediate injection: text written to a PTY while the agent is mid-turn may be swallowed by the running program or land inside a partially-typed input. This is the chosen behaviour and the plan implements it. Two things reduce the damage without changing the semantics: writes are wrapped in bracketed-paste so multi-line text arrives as one atomic paste, and the UI shows a per-message delivery record so a lost message is visible rather than silent. Idle-gated delivery can be added later as an opt-in per-profile flag.

---

## Architecture

```
┌─ Browser ──────────────────────────────────────────┐
│  React app: one world-space canvas                 │
│  · pan/zoom transform, windows in world coords     │
│  · xterm.js per visible window (LOD: snapshot when │
│    zoomed out / offscreen)                         │
│  · message edges drawn between windows             │
└──────── WebSocket (binary PTY frames + JSON) ──────┘
                        │  127.0.0.1 only, token auth
┌─ Local hub (Node) ─────┴───────────────────────────┐
│  Fastify: static web assets, WS, MCP HTTP endpoint │
│  SessionManager  → node-pty processes              │
│  AgentDirectory  → addresses, status, routing      │
│  MessageRouter   → local inject | forward to peer  │
│  SQLite          → hosts, workspaces, layout,      │
│                    sessions, screen snapshots      │
│  SshDeployer     → provision + tunnel remote hubs  │
└───────── SSH tunnel (hub↔hub JSON-RPC) ────────────┘
┌─ Remote hub (same package, --headless) ────────────┐
│  identical hub, no web assets served               │
│  its own MCP endpoint on remote 127.0.0.1          │
│  remote agents talk to their local hub only        │
└────────────────────────────────────────────────────┘
```

**Why the MCP server is HTTP, not stdio:** the hub exposes one streamable-HTTP MCP endpoint. Each spawned agent gets a generated `--mcp-config` pointing at `http://127.0.0.1:<port>/mcp` with an `Authorization: Bearer <per-agent-token>` header. The token identifies the caller, so `send_message` knows who the sender is without the agent having to assert it. No per-agent bridge subprocess is needed. Agents on a remote host point at *their own* hub's loopback endpoint; cross-host delivery is a hub-to-hub concern the agent never sees.

### Repository layout

```
aiCliCanvas/
  package.json                 npm workspaces, "dev" / "build" / "test"
  packages/
    protocol/                  zod schemas + TS types shared by hub and web
      src/ws.ts                client↔hub WebSocket message union
      src/peer.ts              hub↔hub RPC union
      src/mcp-tools.ts         MCP tool input/output schemas
    hub/
      src/server.ts            Fastify: static, /ws, /mcp, /health
      src/session/manager.ts   PTY lifecycle, resize, kill, scrollback
      src/session/pty.ts       node-pty wrapper (ConPTY / unix)
      src/session/status.ts    idle/busy detection
      src/agents/profiles.ts   agents.toml loader + templating
      src/agents/directory.ts  address registry across local + peers
      src/agents/router.ts     message routing + injection
      src/mcp/server.ts        MCP tools over streamable HTTP
      src/remote/deployer.ts   ssh provision, tunnel, health, version check
      src/remote/peer.ts       hub↔hub client
      src/db/                  better-sqlite3 schema + migrations
      src/cli.ts               bin: local mode / --headless remote mode
    web/
      src/canvas/              viewport transform, hit-testing, minimap
      src/window/              window chrome, xterm mount, LOD snapshot
      src/state/               store: sessions, layout, messages
      src/net/                 WS client, reconnect + replay
  profiles/agents.toml         default agent profiles (claude, shell)
```

### Key dependencies

| Concern | Package | Note |
|---|---|---|
| PTY | `node-pty` | prebuilds for win/mac/linux; ConPTY on Windows |
| Terminal UI | `@xterm/xterm` + `@xterm/addon-fit`, `-webgl`, `-serialize`, `-search` | scoped packages |
| Screen capture / replay | `@xterm/headless` + `@xterm/addon-serialize` | one headless terminal per session: backs both live reattach and the persisted snapshot |
| HTTP/WS | `fastify`, `@fastify/websocket`, `@fastify/static` | |
| MCP | `@modelcontextprotocol/sdk` | streamable HTTP transport |
| DB | `better-sqlite3` | native, but we already ship node-pty |
| Schemas | `zod` | one source of truth for WS + MCP |
| SSH | `ssh2` | programmatic exec/sftp/forwarding, no external ssh binary |
| Build | `vite` (web), `tsup` (hub), `vitest`, `playwright` | |

---

## State persistence — SQLite

**The governing principle:** SQLite holds everything needed to redraw the canvas and relaunch every agent exactly as it was. It deliberately does *not* hold conversation history, because that already exists — Claude Code keeps each conversation at `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. Our DB stores the *pointer* to it. That is why resume is cheap, why we never duplicate transcripts, and why a remote agent's history correctly stays on the remote host.

Single database at `~/.aicanvas/state.db` (`%USERPROFILE%\.aicanvas\` on Windows), WAL mode.

```sql
-- topology
host(id, label, ssh_host, ssh_user, ssh_port, key_ref,
     hub_version, state, last_seen_at)
workspace(id, name, kind /* local|remote */, root_path,
          host_id NULL, color, created_at, archived_at)

-- sessions: enough to relaunch faithfully
session(
  id, workspace_id, name, profile, cwd,
  agent_session_uuid,   -- passed as --session-id; later reused as --resume
  argv_json, env_json,  -- fully resolved command line, so relaunch is exact
  spawned_by NULL,      -- parent session id -> agent lineage
  state,                -- starting|running|stopped|exited|failed
  pid, exit_code, created_at, exited_at, last_active_at
)
session_snapshot(session_id PK, serialized BLOB, cols, rows, captured_at)

-- canvas
window(session_id PK, x, y, w, h, z, collapsed)
viewport(id PK CHECK(id=1), pan_x, pan_y, zoom)   -- restore the user's view too

-- messaging (full history retained; it is small and it is the audit trail)
message(id, from_addr, to_addr, body, sent_at,
        delivered_at, delivery_state, error)

schema_meta(version, applied_at)
```

**Write policy.** WAL + `synchronous=NORMAL`. Layout writes debounced ~250 ms during drags. Snapshots debounced ~5 s per active session, and forced on process exit and on `SIGINT`/`SIGTERM`. Snapshot capture costs nothing extra: it reuses the headless xterm the hub already runs per session to serialize the current screen.

**Restore on startup**
1. Load hosts, workspaces, windows and viewport. The canvas draws immediately — correct positions, correct zoom — before a single process is started.
2. Each window renders its `session_snapshot` into its xterm and shows a `stopped` chip. The whole board is readable with nothing running.
3. **Resume**, per window or "Resume all" for a workspace: the hub relaunches from `argv_json`, substituting `--resume <uuid>` for `--session-id <uuid>` on profiles that declare resume support, in the recorded `cwd`. **The cwd must match exactly** — Claude Code keys its session store by working directory, so a mismatch silently starts a fresh conversation instead of failing loudly. Verified against the installed CLI: `--resume` works interactively, and `--fork-session` is available if we later want to branch instead of continue.
4. Profiles without resume support (`shell`) restart clean.
5. `spawned_by` survives, so lineage edges redraw even for sessions never resumed.

**The cost of snapshot-only, stated plainly:** a hub restart preserves the last screenful of each terminal and nothing above it. Scrollback history is not durable. Separately, while the hub *is* running, a per-session in-memory ring buffer backs LOD detach/reattach and browser reconnect — that ring is runtime-only and intentionally never written to disk. If durable scrollback is wanted later, it is an additive `session_output` table; nothing here blocks it.

**Remote state.** Each remote hub owns its own `state.db` with its own sessions and snapshots. The local DB stores hosts, workspaces and window layout only — no mirror. Consequence: when a tunnel is down, remote windows still appear in the right place (layout is local) but render empty and flagged offline; content returns on reconnect.

**Migrations.** A numbered migration runner keyed on `schema_meta.version`, run at startup on both local and remote hubs. The hub↔hub handshake compares schema versions alongside `hub_version` and refuses to connect on mismatch rather than corrupting a peer.

**Addressing.** Every session has a stable address `workspace/name`, e.g. `api/reviewer-1`. Names are unique per workspace and auto-suffixed on collision. The `AgentDirectory` merges the local table with each connected peer hub's table, so `list_agents` returns one flat cross-host list and the router decides local-inject vs peer-forward from the workspace's host.

---

## Agent profiles

`profiles/agents.toml`, overridable per workspace:

```toml
[claude]
command = "claude"
args = [
  "--mcp-config", "{{mcp_config_path}}",
  "--strict-mcp-config",
  "--session-id", "{{session_uuid}}",
  "--settings", "{{settings_path}}",
  "--append-system-prompt-file", "{{brief_path}}",
]
env = { AICC_ADDRESS = "{{address}}" }
status = "hooks"        # exact turn boundaries via Claude Code hooks
inject = "bracketed"    # bracketed paste + CR

[shell]
command = "{{default_shell}}"
args = []
status = "heuristic"
inject = "raw"
mcp = false             # plain terminal, no agent wiring
```

All Claude Code flags above are verified against the installed CLI (`--mcp-config`, `--strict-mcp-config`, `--session-id`, `--settings`, `--append-system-prompt`).

**Status detection — two mechanisms:**
1. `status = "hooks"` (preferred, used by the claude profile). The hub writes a per-session settings JSON containing hooks that `curl`/POST to `http://127.0.0.1:<port>/hook/<session-token>` on `UserPromptSubmit` and `Stop`. This gives exact busy/idle transitions instead of guessing from output.
2. `status = "heuristic"` (fallback, any CLI). Idle when no PTY output for N ms and the last non-empty line matches the profile's `ready_hint` regex. Good enough for the status chip; never used to gate delivery.

**The brief.** Each spawned agent gets a generated `--append-system-prompt-file` telling it its own address, its workspace, who else is currently in the workspace, and that messages arriving in its terminal prefixed `[from <addr>]` are from another agent. Without this an agent has no idea why text is appearing in its input.

---

## MCP tools exposed to agents

| Tool | Input | Behaviour |
|---|---|---|
| `whoami` | — | `{address, workspace, cwd, host}` |
| `list_agents` | `{workspace?}` | all agents across all hubs: address, profile, status, title |
| `send_message` | `{to, text}` | immediate injection into target PTY; returns `{delivered_at}` or an error if the target is dead |
| `spawn_agent` | `{profile?, name?, workspace?, prompt?}` | new PTY + canvas window placed near the caller; optional first prompt injected once the process is up; returns `{address}` |
| `read_screen` | `{address, lines?}` | last N rendered lines of another agent's terminal — lets a supervisor check on a worker without messaging it |
| `set_status` | `{text}` | sets the caller's window subtitle on the canvas |
| `stop_agent` | `{address}` | terminate; permitted only for sessions the caller spawned, unless policy says otherwise |

`spawn_agent` defaults to the caller's own workspace, which matches the requirement that agents spawn peers into the same workspace. Cross-workspace spawn is allowed but requires an explicit `workspace` argument.

**Injection format.** One paste, attributed, terminated with CR:

```
ESC[200~[from api/reviewer-1] <text>ESC[201~CR
```

---

## Canvas rendering — the hard part

Naively putting N live xterm instances inside a `transform: scale()` container is what makes this kind of UI fall over: fractional scaling blurs the WebGL renderer, and every mounted terminal keeps parsing output whether or not you can see it.

**Approach — level of detail, borrowed from design tools:**
- One world layer with a single `transform: translate(x,y) scale(k)`. Windows are absolutely positioned in world coordinates; only the layer transform changes on pan/zoom, so panning never triggers layout.
- **Zoom ≥ ~0.6 and in viewport →** live xterm.js with the WebGL addon.
- **Otherwise →** the terminal is unmounted and replaced by a cheap snapshot: the last ~40 lines as plain styled text plus a status chip. The hub keeps producing output into the session's server-side scrollback either way, so nothing is lost while detached.
- Re-attaching replays a serialized snapshot (`@xterm/addon-serialize` on a headless terminal in the hub) followed by the live stream, so a re-mounted window shows correct state immediately rather than an empty screen.
- The hub is the source of truth for scrollback *while it is running* (in-memory ring, not the DB). The browser holds no history it cannot rebuild from the hub. Across a hub restart only the persisted screen snapshot survives — see **State persistence**.

**Other canvas behaviour:** drag to move, resize handles (resize sends `SIGWINCH` via `pty.resize` with the new col/row), workspace-coloured grouping frames, a minimap, `Cmd/Ctrl+K` command palette, and animated edges between windows when a message is delivered so message flow is visible on the canvas.

---

## Remote hubs

1. **Add host** — user supplies ssh host/user/port and a key or agent reference. `ssh2` connects.
2. **Probe** — check for Node ≥ 22 and an existing hub install; compare `hub_version` against local.
3. **Provision** — if missing or stale, `npm pack` the hub package locally, SFTP the tarball, install it into `~/.aicanvas/`, and (on Linux/macOS) rebuild native deps for the remote arch. Report clearly if the remote lacks a toolchain rather than failing opaquely.
4. **Start** — launch `aicanvas --headless --port 0 --token <generated>` bound to remote `127.0.0.1`; read the chosen port back from stdout. The daemon is detached, so it survives the SSH session ending.
5. **Tunnel** — open an `ssh2` local port forward to that loopback port. The remote hub is never exposed on a public interface.
6. **Register** — handshake, exchange versions, subscribe to the peer's session events. Remote sessions and their PTY streams now appear on the canvas exactly like local ones.
7. **Reconnect** — on tunnel loss, retry with backoff; on reconnect, re-attach to still-running sessions and replay their snapshots. This is the payoff for choosing a daemon over an `ssh` subprocess.

---

## Security

This app lets an agent write arbitrary text into another agent's stdin and spawn new agents. That is the feature, and it is also the risk surface — an agent that reads a hostile repo could be induced to call `send_message` with attacker-chosen text aimed at a peer.

- Hub binds `127.0.0.1` only, never `0.0.0.0`. Remote hubs likewise, reachable solely through the SSH tunnel.
- Per-session bearer tokens for both the WS and MCP endpoints; the browser gets its own separate token. Tokens live in `~/.aicanvas/` with `0600`.
- `send_message` bodies are length-capped and rate-limited per sender, and always carry a visible `[from <addr>]` attribution that an agent cannot spoof — the sender is taken from the token, never from the arguments.
- Every message is persisted with sender, target, body, and delivery outcome, and is inspectable in the UI. Nothing is delivered invisibly.
- `spawn_agent` is subject to a configurable per-workspace cap to bound runaway recursive spawning.
- Permission flags for spawned agents come from the profile and are surfaced in the UI; `--dangerously-skip-permissions` is never a default.

---

## Build phases

Each phase ends at something runnable.

**Phase 1 — Skeleton, one terminal.**
Workspaces, `tsup`/`vite` builds, `packages/protocol` with the WS schema. Hub spawns one PTY via node-pty and streams it over WS; web renders a single fixed xterm with fit + resize round-trip. Verifies the riskiest cross-platform piece (ConPTY vs unix PTY) first.

**Phase 2 — The canvas.**
World-space transform, pan/zoom, draggable/resizable windows, multiple concurrent PTYs, LOD swap between live xterm and snapshot, viewport virtualization. Layout persisted to SQLite.

**Phase 3 — Workspaces and durable state.**
Workspace CRUD bound to local folders, per-workspace grouping on canvas. Full SQLite schema and migration runner. Snapshot capture loop (debounced + forced on exit and on signals), in-memory ring buffer for live reattach, browser reconnect without losing sessions. **Cold-start restore:** kill the hub with agents running, restart it, and the canvas comes back — positions, zoom, last screen of every terminal — with sessions marked `stopped`. Resume-from-`argv_json` lands here too, so a restarted Claude Code session continues its prior conversation.

**Phase 4 — Agents and messaging (local only).**
`agents.toml` loader, per-session token + generated `--mcp-config`, MCP HTTP endpoint with `whoami` / `list_agents` / `send_message` / `set_status`, immediate bracketed-paste injection, Claude Code hook-based status, message log UI. **This is the first phase where the core idea is demonstrable:** two Claude Code sessions in one workspace talking to each other.

**Phase 5 — Spawning and choreography.**
`spawn_agent` with auto-placement near the parent, `read_screen`, `stop_agent`, spawn caps, generated briefs, animated message edges, parent→child lineage drawn on the canvas.

**Phase 6 — Remote hubs.**
`ssh2` deployer, provisioning and version handshake, tunnel management, hub↔hub RPC, merged cross-host agent directory, cross-host `send_message`, reconnect and re-attach.

**Phase 7 — Polish.**
Command palette, cross-terminal search, keybindings, session templates ("open workspace X with these 3 agents"), transcript export, packaging as `npx aicanvas`.

---

## Verification

**Automated**
- `vitest` unit tests: protocol schema round-trips, address allocation and collision suffixing, router local-vs-peer decisions, profile templating, injection encoding (bracketed paste framing is byte-exact).
- Integration test, no LLM required: start a hub, spawn two `shell`-profile PTYs, call `send_message` through the MCP endpoint, assert the target shell's output contains the injected text and that the `message` row records delivery. Same test drives `spawn_agent` and asserts a third session appears.
- Remote integration: run a second hub as a local subprocess in `--headless` mode with a stubbed transport in place of SSH, and assert cross-hub routing. A real SSH path is verified manually against a Linux VM.
- `playwright`: pan/zoom preserves world position, LOD swaps at the zoom threshold, a detached-then-reattached window shows replayed screen content rather than a blank one.
- **Persistence tests, the important ones here:** migration runner applies cleanly from empty and is idempotent; a snapshot round-trips byte-for-byte through serialize → SQLite → deserialize into a fresh xterm; `argv_json` replay produces a command line identical to the original except for `--session-id` → `--resume`; killing the hub with `SIGKILL` mid-session still leaves a readable DB (WAL recovery) with the last forced snapshot intact; restore with a peer host unreachable yields offline-flagged windows in the correct positions rather than an error.

**Manual, per phase**
- Phase 1 on all three OSes: `npm run dev`, confirm a working shell, resize the window, confirm the PTY reflows.
- Phase 3 restore, on all three OSes: run three agents in two workspaces, move the windows, hard-kill the hub, restart. Canvas returns with correct layout and last screens; "Resume all" brings the Claude Code sessions back mid-conversation — confirm by asking a resumed agent what it was just working on.
- Phase 4 end-to-end: open one workspace, start two Claude Code agents, ask agent A to call `list_agents` then `send_message` to agent B, and watch the text land in B's terminal and B act on it.
- Phase 5: ask an agent to `spawn_agent` a worker and delegate a task; confirm the new window appears, the task is forwarded, and the worker reports back by messaging the parent.
- Phase 6: add a remote host, open a remote workspace, confirm agents start there, message a local agent, then kill the SSH tunnel and confirm sessions are still alive and re-attach with correct scrollback.

**Cross-platform gate before each release:** Phase 1 and Phase 4 manual checks run on Windows, macOS, and Linux. node-pty and `better-sqlite3` are the two native deps; if a platform lacks prebuilds, that is a release blocker.
