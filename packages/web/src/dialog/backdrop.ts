/**
 * Whether a click on a dialog is a click on its backdrop.
 *
 * A modal `<dialog>` fills the viewport, so the backdrop is the dialog element
 * itself and the card inside it is a child. Checking only where the click
 * landed is not enough: when the press and the release land on different
 * elements, the browser sends the click to the closest element containing
 * both. Drag-selecting text in a field and letting go outside the card
 * therefore delivers the click to the dialog, and the dialog closed under the
 * selection (issue 47).
 *
 * So it takes where the pointer went down and where it came up as well, and a
 * backdrop dismissal is a press *and* a release on the dialog itself.
 *
 * The click's own target is still checked on top of that, because a click
 * does not always come from the pointer. Enter in a field or Space on a button
 * dispatches one with no pointer events, and a right- or middle-press on the
 * backdrop leaves the recorded press and release behind without ever
 * producing a click. Either way the stale pair must not let that click close
 * the dialog mid-submit.
 *
 * Kept pure and kept here rather than inline in the component so it can be
 * tested without a DOM, which is the only environment the web tests have.
 */
export function isBackdropDismiss(
  dialog: unknown,
  pressed: unknown,
  released: unknown,
  clicked: unknown,
): boolean {
  return (
    dialog != null &&
    pressed === dialog &&
    released === dialog &&
    clicked === dialog
  );
}
