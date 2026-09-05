# Bugs

Known defects, worst first. Each entry says what you see, what should happen,
and where the code lives. Delete an entry when it is fixed — the git history
keeps the record.

---

## 1. The status dot does not follow what the agent is doing

**What you see.** The dot in a terminal's title bar stays on one colour. An
agent that is mid-turn still shows green (idle), and one sitting at its prompt
can stay amber (working). The dot is only reliable at the moment a session
starts.

**What should happen.** Amber the whole time the agent is working, green as
soon as it is waiting for input, for every profile — Claude Code via hooks and
plain shells via the heuristic.

**Where it lives.**
- `packages/web/src/window/TerminalWindow.tsx:26` — `statusColor` maps
  `session.status` to the dot colour, so the dot is only as good as that field.
- `packages/hub/src/agents/wiring.ts:66` — the generated hook settings.
  `UserPromptSubmit`/`PreToolUse` post `?event=busy` and `Stop` posts
  `?event=idle` to `/hook/<token>`. Worth checking the hooks actually fire and
  reach the hub on Windows (the PowerShell `Invoke-WebRequest` branch), and
  that no turn ends without a `Stop`.
- `packages/hub/src/session/manager.ts:309` — `setStatusFromHook`, the other
  end of that request.
- `packages/hub/src/session/pty.ts:134` — the heuristic path: quiet for a beat,
  then match `readyHint` against the last non-empty line. Claude Code's
  animated spinner and a repainting TUI both defeat a "quiet for a beat" test.
- Whether the resulting change is pushed to the browser at all: a status change
  with no session-update frame on the WebSocket looks identical to a status
  that never changed.

---

## 2. The window title never picks up the agent's own title

**What you see.** A terminal's header shows its canvas address
(`workspace/name`) forever. Claude Code sets a terminal title describing what it
is doing; none of that reaches the canvas.

**What should happen.** The header shows the title the program in the PTY set,
falling back to the address when there is none.

**Where it lives.**
- `packages/protocol/src/domain.ts:91` — `Session.title` exists and is part of
  the wire type.
- `packages/hub/src/session/manager.ts:183` — it is initialised to `null` and
  never written again. Nothing parses the OSC 0/2 title sequence out of the PTY
  stream, so the field has no source.
- `packages/web/src/window/TerminalWindow.tsx:206` — the header and the
  zoomed-out card both render `session.address` and ignore `title`.

Needs three things: strip and capture `ESC ] 0;…BEL` / `ESC ] 2;…BEL` (and the
`ESC \` string terminator) as PTY output passes through the hub, persist it on
the session, and render it. Note the title can change many times a second, so
it wants coalescing before it becomes a broadcast per keystroke.
