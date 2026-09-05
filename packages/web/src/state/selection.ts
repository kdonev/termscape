/**
 * Keeping a picked id honest against the list it came from.
 *
 * The socket reconnects in place, without a page load, so a hub restart
 * replaces every list in the store while the components above keep the
 * `useState` they had. An id chosen before the restart then outlives the thing
 * it named, and the first anyone hears of it is the hub answering "unknown
 * workspace" to a control that looked like it was pointing at something real.
 * Removing a workspace or losing a host does the same thing without a restart.
 *
 * So no picked id is trusted on its own: it is resolved against the list as it
 * stands now, every render.
 */
export function pickValid<T extends { id: string }>(
  id: string,
  list: readonly T[],
  /** Fall back to the first entry, for a control that must always name one. */
  fallbackToFirst = false,
): string {
  if (list.some((x) => x.id === id)) return id;
  return fallbackToFirst ? (list[0]?.id ?? '') : '';
}
