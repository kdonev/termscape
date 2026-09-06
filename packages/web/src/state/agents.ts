import type { AgentProfileInfo } from '@termscape/protocol';

/**
 * Which agent list belongs to a machine.
 *
 * There is one list per machine and no global one, because a host has its own
 * PATH. `hostId` is null for this machine, which is the only one whose list
 * the hub can produce itself.
 */
export function agentsOn(
  hostId: string | null,
  local: AgentProfileInfo[],
  byHost: Record<string, AgentProfileInfo[]>,
): AgentProfileInfo[] {
  if (hostId === null) return local;
  return byHost[hostId] ?? [];
}

/**
 * What the picker should offer for a machine, and what it should refuse.
 *
 * A declared agent that is not installed stays in the list and says why -
 * dropping it looks like the config was ignored - but it cannot be started,
 * because starting it fails inside a terminal window where the error reads
 * like the hub is broken. One still being probed is offered: detection is
 * slower than a person opening a dropdown, and refusing until it answers
 * would be worse than occasionally letting a launch fail the old way.
 */
export function startable(agent: AgentProfileInfo): boolean {
  return agent.available !== false;
}

/**
 * Whether the agent a template names can be started on this machine.
 *
 * A template is config and lives on the canvas hub; whether its agent exists
 * is the other machine's answer, so the two are joined in the browser. An
 * agent nobody has probed yet counts as startable, for the same reason
 * `startable` says so: detection is slower than opening a dropdown.
 */
export function startableAgent(
  template: { agent: string },
  agents: AgentProfileInfo[],
): boolean {
  const agent = agents.find((a) => a.id === template.agent);
  // Not in the list at all means the machine does not declare it - which for
  // a peer running an older hub is every agent, and refusing them all would
  // make the picker empty rather than merely optimistic.
  return agent === undefined || startable(agent);
}

/** The one line under an agent's name in a list. */
export function agentDetail(agent: AgentProfileInfo): string {
  if (agent.available === false) return agent.detail ?? `not found: ${agent.command}`;
  if (agent.available === null) return 'checking…';
  const parts: string[] = [];
  if (agent.version) parts.push(agent.version);
  if (agent.models.length > 0) {
    parts.push(
      agent.modelSource === 'listed'
        ? `${agent.models.length} model${agent.models.length === 1 ? '' : 's'}`
        : `${agent.models.length} known model${agent.models.length === 1 ? '' : 's'}`,
    );
  }
  if (!agent.mcp) parts.push('no hub wiring');
  return parts.join(' · ');
}
