# Bugs

Known defects, worst first. Each entry says what you see, what should happen,
and where the code lives. Delete an entry when it is fixed — the git history
keeps the record.

---

## 1. The window title never picks up the agent's own title

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
