# Bugs

Known defects, worst first. Each entry says what you see, what should happen,
and where the code lives. Delete an entry when it is fixed — the git history
keeps the record.

- Scrolling with the mouse does not work with a remote terminal. Mouse reports
  in the default encoding now reach the PTY at all, which they did not before
  (`packages/web/src/window/Terminal.tsx`, the `onBinary` wiring), but the
  remote-only half of this has not been reproduced: the wheel, the input frame
  and the attach snapshot all take the same path for a peer's session as for a
  local one. Needs a repro that says which agent and which host.
