import { describe, expect, it } from 'vitest';
import { isBackdropDismiss } from '../src/dialog/backdrop.js';

/*
 * A dialog closes on its backdrop only when the press, the release and the
 * click all land on the dialog element. The click a drag-select produces is
 * delivered to the dialog when it starts in a field and ends outside the card,
 * and that must not close it (issue 47). A click with no pointer behind it - a
 * keyboard one - must not close it either, even if an earlier press and
 * release are still recorded. Plain objects stand in for the targets: only
 * their identity is compared.
 */
describe('isBackdropDismiss', () => {
  const dialog = {};
  const field = {};

  it('closes when the press, release and click are all on the dialog', () => {
    expect(isBackdropDismiss(dialog, dialog, dialog, dialog)).toBe(true);
  });

  it('stays open when the press was on a child and the release on the dialog', () => {
    expect(isBackdropDismiss(dialog, field, dialog, dialog)).toBe(false);
  });

  it('stays open when the press was on the dialog and the release on a child', () => {
    expect(isBackdropDismiss(dialog, dialog, field, dialog)).toBe(false);
  });

  it('stays open when everything is on a child', () => {
    expect(isBackdropDismiss(dialog, field, field, field)).toBe(false);
  });

  it('stays open when a stale press and release meet a click on a child', () => {
    expect(isBackdropDismiss(dialog, dialog, dialog, field)).toBe(false);
  });

  it('stays open when there is no dialog', () => {
    expect(isBackdropDismiss(null, null, null, null)).toBe(false);
  });
});
