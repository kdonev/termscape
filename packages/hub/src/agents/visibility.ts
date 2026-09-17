/**
 * Who may see whom on the canvas (issue 22).
 *
 * Visibility follows lineage, never the machine or the workspace. An agent the
 * human started - a root - sees every other root, wherever it runs. An agent
 * spawned by another sees only its parent, so siblings working on pieces of
 * one task do not find each other and start coordinating behind the agent
 * that split it. And every agent sees its own direct children, but not
 * theirs: a grandchild is its parent's business.
 *
 * "Sees" is both the listing and the access. Every place that answers who
 * exists or acts on an address asks this, so the rule lives in exactly one
 * place. Whether the viewer is the other agent is the caller's question.
 */

/** The only two things the rule needs to know about an agent. */
export interface Lineage {
  address: string;
  /** Who spawned it, by address; null or absent for one the human started. */
  parentAddress?: string | null;
}

export function canSee(viewer: Lineage, other: Lineage): boolean {
  return (
    other.parentAddress === viewer.address ||
    viewer.parentAddress === other.address ||
    (viewer.parentAddress == null && other.parentAddress == null)
  );
}
