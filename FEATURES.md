# Features

Wanted features, next first. Each entry says what it is, how it should behave,
and where the code lives. Delete an entry when it ships — the git history keeps
the record.

---

## 1. Clicking the canvas closes the side panel

**What it is.** The machines panel slides over the right of the canvas and only
closes from its own `›` button or the toolbar. Reaching for either is a
detour when the thing you actually want is the canvas you can already see.
Clicking the canvas should close it.

**How it behaves.**

- **Any pointer down inside the canvas closes it**, whether it lands on empty
  canvas or on a terminal window. Both mean the same thing: you are done with
  the list and back on the canvas.
- **Nothing inside the panel closes it.** Adding a workspace, starting an
  agent, expanding a node — all of that is panel work, and the panel is a
  sibling of the canvas rather than a child, so those clicks never reach it.
- **Clicking an agent row is the exception worth thinking about.** It moves the
  canvas to that window, and the click is on the panel, so the panel stays
  open — which is right when you are working down a list of agents, and wrong
  if you meant to go there and get on with it. Leave it open, since the canvas
  is one click away from closing it anyway.
- **Escape should close it too**, before it clears the selection, so the key
  unwinds one thing at a time.

**Where it lives.**

- `packages/web/src/canvas/Canvas.tsx:211` — `onPointerDown` on `.canvas`. Note
  its second line returns early unless the event landed on the canvas itself,
  which is what stops a click on a window from starting a pan. The close
  belongs *above* that guard: pointer events from a window bubble up to this
  element, so one line there covers both cases and no change to
  `window/TerminalWindow.tsx` is needed.
- `packages/web/src/state/store.ts:210` — `setPanelOpen`. Worth guarding on the
  current value rather than writing `false` on every canvas click: each write
  is a new store object and a re-render for everything subscribed to it, and
  most canvas clicks happen with the panel already shut.
- `packages/web/src/canvas/Canvas.tsx:600` — the Escape branch, if that half is
  taken as well. It currently clears the selection unconditionally; it would
  need to close the panel first and clear the selection only when the panel was
  already closed.
- `packages/web/src/panel/Panel.tsx:44` — the `›` button, which stays as the
  deliberate way to close it.
