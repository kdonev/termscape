# Keyboard

Every part of the canvas can be driven without the mouse: moving between
agents, reading a note, zooming, starting a new terminal.

The hard part is that most of the time the keyboard belongs to an agent. On a
canvas whose point is a crew of agents, almost every key you press is meant for
one of them, so the shortcuts come in two kinds — **chords**, which work even
mid-sentence to an agent, and **canvas mode**, which takes the keyboard off the
agent for as long as you are navigating.

Press **?** in canvas mode for the same list inside the app.

## Chords

These work anywhere, including while you are typing to an agent.

| Keys | What it does |
| --- | --- |
| **Ctrl/⌘ + Shift + Space** | Canvas mode on or off |
| **Ctrl/⌘ + Shift + K** | [Command palette](#the-palette) |
| **Ctrl/⌘ + Shift + F** | [Jump to a window by its badge](#jumping-by-badge) |
| **Ctrl/⌘ + Shift + E** | Machines panel |
| **Ctrl/⌘ + Shift + ←↓↑→** | Select the next window or note over |
| **Ctrl/⌘ + +** / **Ctrl/⌘ + -** | The [zoom ladder](#the-zoom-ladder) |

### Why Ctrl/⌘ + Shift

A terminal cannot tell `Ctrl+Shift+K` from `Ctrl+K`: both are the byte `0x0B`,
because the control range has no room for a shift bit. No agent can bind the
shifted form, so taking it costs you nothing — `Ctrl+K` still reaches the agent
as `Ctrl+K`. It is also where every terminal emulator puts its own commands, so
the shape is already familiar.

Three programs do read the key event rather than the byte, and those are left
alone: **Ctrl+Shift+-** is undo in Claude Code, and **Ctrl+Shift+Z** and
**Ctrl+Shift+G** are redo and open-in-editor in Gemini CLI.

That last point is the one asymmetry worth remembering: **zoom in** takes
`Ctrl + =` or `Ctrl + +` (either), while **zoom out** takes `Ctrl + -`
*unshifted only*. `Ctrl+Shift+-` is left to the agent, because that is also
`Ctrl+_`, undo in any shell.

Shortcuts match the physical key, not the character it produces, so they keep
working with a non-Latin keyboard layout active.

## Canvas mode

**Ctrl/⌘ + Shift + Space** takes the keyboard off the agent so plain keys can
navigate. The top bar says **canvas keys** while it is on. **Enter** hands the
keyboard back to the selected agent, **Esc** unwinds, and clicking into a
terminal or a note also ends it — a click means you want to type there.

| Keys | What it does |
| --- | --- |
| `h` `j` `k` `l` or arrows | Select the next window or note over |
| **Shift** + those | Pan |
| `+` / `-` | The same zoom ladder |
| **Tab** / **Shift + Tab** | Next or previous window or note, wrapping |
| `1`–`9` | The nth window of this workspace |
| **Enter** | Type to the selected agent, or into the note |
| `f` | Jump to a window by its badge |
| `/` | Command palette |
| `p` | Machines panel |
| `a` | New agent in this workspace |
| `n` | New note |
| **Shift + W** | New workspace |
| `r` | Resume or restart the selected agent |
| `x` | Remove the selected window (asks first) |
| `?` | Every shortcut, listed |
| **Esc** | Close, then deselect, then leave canvas mode |

`hjkl` picks the nearest thing *in that direction* rather than the nearest
thing overall, so "down" means the window below rather than one off to the
side, and it stops at the edge instead of wrapping. **Tab** has no direction to
run out of, so that one does wrap.

### Notes

Notes are navigation stops like windows: `hjkl` and **Tab** land on them,
**Enter** puts the cursor in the text, and **Ctrl/⌘ + Shift + Space** takes it
back out. Navigation that skipped them would make a note the one thing on the
canvas you still need a mouse for.

A selected note has its own two-rung zoom ladder — the note, then everything —
since a note belongs to no workspace.

## The zoom ladder

**Ctrl/⌘ + +** and **Ctrl/⌘ + -** step through three views rather than zooming
smoothly:

```
everything  ←— Ctrl+-  —  the workspace  —  Ctrl++ —→  one window
```

The anchor is whatever is selected, or the window nearest the middle of the
screen if nothing is. Which rung you are on is worked out from what is on
screen rather than remembered, so panning and zooming by hand in between never
desyncs it.

A workspace holding a single window is skipped: its box is that window plus a
little padding, and a key press that visibly does nothing reads as broken.

For smooth zooming, **Ctrl/⌘ + scroll** still works, and a quick flick of the
zoom navigates the same ladder.

## Jumping by badge

**Ctrl/⌘ + Shift + F**, or `f` in canvas mode, puts a letter badge on every
window and jumps to the one you type. The canvas first pulls back far enough to
show every window, because a badge on a window off screen is a badge nobody can
read; cancelling with **Esc** puts the view back exactly as it was.

Badges are all the same length — one letter while nine cover it, two after
that. Mixed lengths would make `a` both a complete badge and the start of
another, which needs either a timeout or a terminator key.

**Backspace** undoes a letter, and any key that cannot become a badge closes
the jump rather than being swallowed.

## The palette

**Ctrl/⌘ + Shift + K**, or `/` in canvas mode, opens one search box over three
things:

- **Every window**, under the address on its title bar. Type part of it and
  press Enter to fly there and start typing to that agent.
- **Every command**, so the keys above never have to grow to cover everything.
- **Every workspace crossed with every agent template**, as *New claude in
  termscape* — one search to start a terminal anywhere, without opening a
  dialog and picking twice.

Matching is fuzzy and understands initials, so `nw` finds *New workspace* and
`na` finds *New agent*. Rows are matched as written, so `claude in web` works
while `web claude` does not; typing either half alone narrows to everything it
could pair with.

A template whose agent is not installed on that workspace's machine is not
offered — whether an agent exists is that machine's answer, and each has its
own `PATH`. To set a model, an effort or an opening task, use **+ agent** in
the panel; the palette is the quick path, not a replacement for the dialog.

**↑** / **↓**, or **Ctrl+P** / **Ctrl+N**, move through the results.
