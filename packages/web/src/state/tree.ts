import { parseAddress, type Host, type Session, type Workspace } from '@aicanvas/protocol';

/**
 * The canvas as a tree: machines, the workspaces on each, the agents in each
 * workspace.
 *
 * Derived from the three flat lists in the store rather than stored, so it can
 * never disagree with them.
 */

export interface TreeWorkspace {
  workspace: Workspace;
  sessions: Session[];
}

export interface TreeMachine {
  /** '' for this machine, which owns every workspace with no host. */
  id: string;
  label: string;
  /** Platform or ssh target, when there is one worth showing. */
  sub: string | null;
  state: Host['state'];
  /** Null for this machine: there is no host row for the hub you are talking to. */
  host: Host | null;
  workspaces: TreeWorkspace[];
}

/**
 * The sessions belonging to a workspace.
 *
 * A local one is matched by id. A remote one cannot be: the peer owns that
 * session and stamps it with the id of its own workspace row, which means
 * nothing in this database. What does survive the trip is the address, whose
 * first segment is the workspace name the peer was asked to create.
 */
export function sessionsIn(workspace: Workspace, sessions: readonly Session[]): Session[] {
  return sessions.filter(
    (s) =>
      s.workspaceId === workspace.id ||
      (workspace.hostId !== null && parseAddress(s.address)?.workspace === workspace.name),
  );
}

/**
 * The second line on a machine's row: where it is, and what it is running. An
 * enrolled host reached us and told us its platform; a deployed one is known
 * by where we dial it.
 */
function describe(host: Host): string | null {
  const where =
    host.kind === 'enrolled'
      ? (host.platform ?? 'joined')
      : host.sshUser && host.sshHost
        ? `${host.sshUser}@${host.sshHost}:${host.sshPort}`
        : null;
  const version = host.hubVersion ? `hub ${host.hubVersion}` : null;
  const parts = [where, version].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function buildTree(
  hosts: readonly Host[],
  workspaces: readonly Workspace[],
  sessions: readonly Session[],
): TreeMachine[] {
  const on = (hostId: string | null) =>
    workspaces
      .filter((w) => (w.hostId ?? null) === hostId)
      .map((workspace) => ({ workspace, sessions: sessionsIn(workspace, sessions) }));

  // This machine leads and is always present, with or without remote hosts. It
  // is where most workspaces live, and it should not be the one thing in the
  // system with no place in the tree.
  const here: TreeMachine = {
    id: '',
    label: 'this machine',
    sub: null,
    state: 'connected',
    host: null,
    workspaces: on(null),
  };

  return [
    here,
    ...hosts.map((host) => ({
      id: host.id,
      label: host.label,
      sub: describe(host),
      state: host.state,
      host,
      workspaces: on(host.id),
    })),
  ];
}
