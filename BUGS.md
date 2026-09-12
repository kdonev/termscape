# Bugs

Known defects, worst first. Each entry says what you see, what should happen,
and where the code lives. Delete an entry when it is fixed — the git history
keeps the record.

## Not ours: a window on Windows 10 gets no mouse, so its wheel is dead

The wheel scrolls a Claude Code window on one machine and does nothing on
another. It reads like a remote-terminal defect and it is not one: it happens
just as thoroughly with the hub running locally on the affected machine.

Measured on two windows at once, same Claude Code build, same grid, idle noise
measured first so the numbers below are signal rather than repaint:

| | this machine | kid7 |
| --- | --- | --- |
| Windows build | 26200 (11) | 19045 (10 22H2) |
| Claude Code | 2.1.267 | 2.1.267 (identical binary, 220,051,616 bytes) |
| screen buffer | alternate | normal |
| mouse tracking | `?1003h` + `?1006h` | none |
| idle repaint | 0 / 23 rows | 0 / 23 rows |
| wheel report injected | **18 / 23 rows** | **0 / 23 rows** |

### What it is not

Ruled out by measurement, each one separately:

- **The agent version.** Both 2.1.267, byte-identical on disk.
- **The remote path.** It reproduces with the hub running on kid7 itself. The
  peer link is byte-faithful anyway — see the round-trip test named below.
- **The environment.** Identical vars on both; `TERM` and `COLORTERM` supplied
  explicitly change nothing. (node-pty never sets `TERM` on Windows: it
  computes `name` and drops it, so both sides run without one.)
- **The ConPTY build.** node-pty ships a modern `conpty.dll` behind
  `useConptyDll`; it genuinely loads it — two conpty shared objects in the
  process instead of one — and the result is unchanged.
- **The hub's console.** The join installer briefly ran the hub attached to the
  installer's console on the theory that a console-less parent makes degraded
  pseudoconsoles. It does not; an agent behaves the same either way. That
  experiment cost the daemon property and was reverted.

### What it is

ConPTY in its normal mode parses the program's output into its own screen
buffer and re-renders it, and the program's VT request for mouse reporting does
not survive that. `PSEUDOCONSOLE_PASSTHROUGH_MODE` (0x8) is what lets those
sequences through untouched, and it exists only on build 22621 and later —
Windows 11 22H2. node-pty never asks for it in any case: `conpty.cc` passes
`dwFlags` as `PSEUDOCONSOLE_INHERIT_CURSOR` or `0`, and the passthrough flag
appears nowhere in it.

So on build 26200 the program's `?1049h`/`?1003h`/`?1006h` reach xterm and the
wheel is the program's business. On 19045 they are swallowed, xterm never
learns that anything wants the mouse, and there is no scrollback to fall back
on because the program redraws in place — hence a wheel that does nothing at
all rather than a wheel that scrolls the wrong thing.

The same machine's own Windows Terminal scrolls fine because Terminal ships its
own newer conhost and settles mouse with ConPTY between themselves; the
program's request never has to reach Terminal as a VT sequence.

### Why there is no fix here

The obvious move — have xterm enable mouse reporting itself, since the
program's request was eaten, and forward the reports — was tried and does not
work. Injected into the affected window, SGR reports move 0 of 23 rows and X10
reports move 1, which is a status-line tick rather than a scroll. ConPTY does
translate incoming VT mouse sequences into `INPUT_RECORD`s, but a client only
receives them once mouse input is enabled in its console mode, and only the
client itself can do that. Nothing outside the process has the lever.

The other documented workaround, dropping to winpty, is gone: node-pty removed
winpty support and now requires ConPTY on 1809+.

What would actually fix it: that machine on Windows 11 22H2 or later, or
node-pty adopting passthrough mode, or this project shipping its own conhost.
None of those is a code change in this repository.

## Tracing a wheel that does nothing

The path a scroll takes is four processes long for a remote terminal — browser,
canvas hub, peer link, the hub that owns the pty — and each one can lose it in
a way the others cannot see. `TERMSCAPE_DEBUG` turns on the same three topics
everywhere:

    input    every keystroke, paste and mouse report at each hop it takes
    output   only the modes a program sets, which decide whose job a wheel is
    attach   attach, resize, and what a replayed snapshot restores

On the canvas machine and **on the attached machine too** — a remote session
traces only half of itself otherwise:

    TERMSCAPE_DEBUG=input,output,attach npx termscape

In the browser, load the canvas with `?debug=input,output,attach`; it sticks
until `?debug=off`. Then scroll over the window that will not scroll.

What the trace answers, in the order worth asking:

1. `wheel -> NOTHING: no report encoded and no local scroll` — nothing asked
   for mouse reports and there is no scrollback to fall back on. Check the
   `output` lines for what the program actually set: no mouse mode at all,
   on a normal screen, is the ConPTY case above and no amount of forwarding
   will fix it.
2. `wheel -> N report(s) to the program`, then `send raw:` — the browser
   encoded it. Follow the same bytes through `browser -> hub`, `hub -> peer`,
   `peer -> pty` and `pty <-`. Each line describes the same report the same
   way, so a hop that changes it shows up as two lines that disagree.
3. `hub -> peer … FAILED: …` — it left the canvas and the far hub did not take
   it. The message says whether that was a timeout or a dead link.
4. A `pty <-` line whose `col=` or `row=` is outside the grid printed beside
   it means the window and the pty disagree on size; compare the `attach`
   lines from both ends.

The forwarding itself is covered by tests rather than left to the trace:
`packages/hub/test/peer.test.ts` sends a real wheel report through a real peer
link and asserts the far pty receives the same bytes, including a coordinate
past column 95 — the case that cannot survive being treated as text.

Two things worth knowing when reading terminal state here, both of which sent
earlier rounds of this investigation down the wrong path:

- A serialized screen that holds exactly `rows` lines and never grows is the
  signature of a program that redraws in place, not of one refusing to scroll.
- "The screen changed" is not evidence that a wheel did anything. A live agent
  window repaints on its own. Measure how *many* rows changed against an idle
  baseline: a scroll moves nearly all of them, a spinner moves one.
