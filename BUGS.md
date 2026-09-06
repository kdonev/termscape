# Bugs

Known defects, worst first. Each entry says what you see, what should happen,
and where the code lives. Delete an entry when it is fixed — the git history
keeps the record.

---

## 1. An agent on an attached machine cannot see the agents on yours

**What you see.** `list_agents`, called by an agent running on a machine you
attached, lists only the agents on that machine. The ones on the machine you
are sitting at are missing, and `send_message` to one of them fails with
`no agent at address "..."`. From this side the view is complete — the canvas
sees both — so the blindness is one-directional, and easy to miss until an
agent over there is asked to hand work back.

**What should happen.** What the README promises: "an agent addresses a peer on
another machine exactly as it addresses one in the next window." Both ends of a
link see each other's agents, and a message crosses in either direction.

**Where it lives.**
- `packages/hub/src/remote/peer-serve.ts:12` — the answering half. It serves
  *this* hub's sessions and pushes *this* hub's changes, and never asks the
  other end for its own. Being independent of who opened the socket is right;
  the problem is that nothing on that socket ever asks.
- `packages/hub/src/remote/registry.ts` — the pulling half, and the only thing
  that holds another hub's sessions. It is built from `host` rows, and a hub
  that joined a canvas has none: the canvas holds a row for it, not the other
  way round. So `peers.sessions()` over there is permanently empty.
- `packages/hub/src/hub.ts:358` — `listAgents` is local sessions plus
  `this.peers.sessions()`. On an attached machine that second half is always
  empty, which is the whole bug in one line.
- `packages/hub/src/hub.ts:394` — `sendMessage` takes the peer path only when
  `locate(to)` says `remote`, which asks the same registry. Over there every
  address that is not local looks like nothing at all, so it goes down the
  local path and is recorded as a failed delivery.
- `packages/protocol/src/peer.ts` — worth knowing before designing the fix: the
  requests needed already exist and are already symmetric on the wire
  (`listSessions`, `deliver`, the `sessionUpserted` push). What is missing is
  the joined hub asking for them and having somewhere to keep the answer.
- Worth deciding rather than assuming: whether an agent on an attached machine
  should see every machine on the canvas, or only the canvas machine and its
  own. Only the canvas hub knows the full set, so the second is a much smaller
  change — and it is the one that makes handing work back work.

---

## 2. A workspace on an attached machine gets no frame around its windows

**What you see.** Start agents in a workspace that lives on another machine and
the dashed frame with the workspace name never appears, however far you zoom
out. The windows are there; nothing groups them.

**What should happen.** Every workspace with a window on the canvas is drawn
inside its own frame, wherever its agents happen to be running.

**Where it lives.**
- `packages/web/src/canvas/Canvas.tsx:629` — the grouping:
  `sessions.filter((s) => s.workspaceId === ws.id)`. A remote session carries
  the *peer's* workspace id, because the peer created that row and owns it, and
  that id is not in this database at all. The filter matches nothing,
  `workspaceBounds` gets an empty list and returns null, and no frame is
  pushed. The windows still draw, because they are keyed by session.
- `packages/web/src/state/tree.ts` — `sessionsIn` is this same question already
  answered for the panel: match by id, and for a workspace on a host fall back
  to the workspace half of the address, which is the one thing that survives
  the trip. The canvas should use it rather than grow a second copy.
- `packages/web/src/canvas/Canvas.tsx:455` — the step-out path groups by
  `workspaceId` the same way and wants the same treatment, or zooming out of a
  remote window steps to the wrong bounds.
- Checked and *not* the fault: two workspaces on this machine each get their
  own frame. A second workspace's windows are placed about 2,600px to the right
  (`session/manager.ts:450`), so it and its frame are off screen until you pan
  or fit — which can read as a missing frame. If a frame is genuinely missing
  for a workspace on this machine, that is a different fault and this entry
  does not cover it.

---

## 3. One notch of a mouse wheel zooms far too far

**What you see.** Zooming with a mouse wheel jumps rather than moves. A single
notch doubles the zoom going in, and a single notch going out drops it to a
fifth — so a notch out followed by a notch in leaves the canvas at 0.4x of
where it started, and finding a comfortable zoom means overshooting in both
directions. A trackpad pinch is fine; this is the wheel.

**What should happen.** A notch is a small step — something in the region of
1.1x — and a notch each way returns you to where you were. The steps a
trackpad pinch produces stay as smooth as they are now.

**Where it lives.**
- `packages/web/src/canvas/viewport.ts:334` — `wheelZoomFactor`, and the whole
  fault is visible in one line: `1 - deltaY * 0.01` against a mouse notch of
  `deltaY` 100 gives 2.0 zooming in and 0 zooming out, and the clamp turns that
  0 into 0.2. Hence both the size of the jump and its asymmetry.
- The clamp is not the thing to just loosen. It is there because a factor of
  zero also destroys the pinch detector: `pinchIntent` accumulates a ratio out
  of these factors (`viewport.ts:397`), and zeroes tell it nothing. Whatever
  replaces the formula has to keep feeding that something meaningful.
- Nor is lowering the 0.01 coefficient on its own the fix: trackpad deltas are
  small and already produce ~1.04 per event, and scaling everything down makes
  a pinch sluggish. The two input kinds have to be told apart — `deltaMode`,
  or the magnitude of the delta, at `packages/web/src/canvas/Canvas.tsx:535`
  where the event is still in hand — and only the discrete one re-scaled.
- `packages/web/test/viewport.test.ts:412` — the existing expectations encode
  the current behaviour, including `wheelZoomFactor(-1000) === 5`. They will
  need rewriting alongside, and are the right place to pin down that a notch
  each way is a round trip.
