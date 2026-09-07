import { readFileSync, existsSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import type { AgentTemplateInfo, TemplateSource } from '@termscape/protocol';
import { paths } from '../paths.js';
import type { Store, StoredTemplate } from '../db/store.js';
import type { AgentProfile, ProfileRegistry } from './profiles.js';

/**
 * A template is an agent plus a model, an effort and an opening instruction.
 *
 * Starting an agent used to ask exactly one question - which CLI - and
 * everything that actually distinguishes one agent from another was missing.
 * A template is a saved answer to all four, picked once instead of typed every
 * time.
 *
 * On the words, because this file cannot be written without settling them:
 *
 * - **agent** is the CLI program, which the code calls a *profile*. That name
 *   stays internal: it is the recipe for launching one CLI.
 * - **template** is what a human picks from a list.
 * - **session** is one running instance, with an address and a window.
 *
 * A template that names only an agent is exactly today's behaviour, which is
 * why every profile gets one for free and nothing that works now stops
 * working.
 */
export interface AgentTemplate {
  id: string;
  description: string;
  /** Profile id. */
  agent: string;
  model?: string;
  effort?: string;
  /**
   * Typed into the terminal once the CLI is up, not written into argv - in
   * argv it would be a different thing entirely, and written immediately it
   * lands before the program is reading.
   */
  prompt?: string;
  /**
   * Why this template cannot be used, when it cannot.
   *
   * Kept rather than dropped, for the same reason a missing agent stays in the
   * list: a template that silently vanished looks like the config was ignored.
   * A template asking for an effort on an agent that has no effort setting is
   * a configuration error worth reporting here, at load, and not a flag
   * quietly dropped at launch.
   */
  error?: string;
  /**
   * Where this one came from, which is what decides whether the panel may
   * edit it.
   *
   * - `derived` — the free template every agent gets under its own name.
   *   Nothing is stored for it, so editing one means creating a stored
   *   template that shadows it, and there is nothing to remove.
   * - `stored` — made from the panel, in `state.db`. Editable and removable.
   * - `file` — declared in `~/.termscape/agents.toml`. Read-only here: it is
   *   the user's file and the hub does not write it.
   */
  source: TemplateSource;
}

/** The trivial template for a profile: this agent, nothing else specified. */
function bare(profile: AgentProfile): AgentTemplate {
  return {
    id: profile.id,
    description: profile.description,
    agent: profile.id,
    source: 'derived',
  };
}

/** One the user made from the panel, as it comes out of the database. */
function fromStored(t: StoredTemplate, profiles: ProfileRegistry): AgentTemplate {
  return {
    id: t.id,
    description: t.description ?? profiles.get(t.agent)?.description ?? t.id,
    agent: t.agent,
    model: t.model ?? undefined,
    effort: t.effort ?? undefined,
    prompt: t.prompt ?? undefined,
    source: 'stored',
  };
}

/**
 * Check a template against the agent it names.
 *
 * Returns the reason it cannot be used, or null. This is where "the agent
 * declares how to spell it" is enforced: a template holds *values*, and a
 * value nobody can spell on the command line is not a template, it is a typo
 * that would otherwise be discovered at launch.
 */
export function validate(
  t: AgentTemplate,
  profiles: ProfileRegistry,
): string | null {
  const agent = profiles.get(t.agent);
  if (!agent) return `unknown agent "${t.agent}"`;
  if (t.model !== undefined && !agent.modelArgs) {
    return `${t.agent} does not take a model on the command line`;
  }
  if (t.effort !== undefined && !agent.effortArgs) {
    return `${t.agent} has no effort setting`;
  }
  return null;
}

export class TemplateRegistry {
  private readonly templates: Record<string, AgentTemplate>;

  constructor(templates: Record<string, AgentTemplate>) {
    this.templates = templates;
  }

  /**
   * One bare template per agent, overlaid with `[template.x]` from
   * ~/.termscape/agents.toml.
   *
   * A broken file falls back to the bare set rather than taking the hub down,
   * exactly as the profile loader does - the two live in the same file, and
   * failing differently for the two halves of it would be its own surprise.
   */
  static load(profiles: ProfileRegistry, store?: Store): TemplateRegistry {
    const merged: Record<string, AgentTemplate> = Object.fromEntries(
      profiles.list().map((p) => [p.id, bare(p)]),
    );

    /*
     * Stored over derived, file over stored.
     *
     * Stored beats derived because a bare template is only a default: making
     * one called `claude` with a model on it is exactly how you say "when I
     * pick claude, I mean this". File beats stored because someone who wrote a
     * template by hand meant it, and a UI silently overriding their file is
     * worse than a UI refusing an id the file has claimed - which is what the
     * hub does on create.
     */
    if (store) {
      for (const t of store.listStoredTemplates()) {
        merged[t.id] = fromStored(t, profiles);
      }
    }

    const file = paths.profiles();
    if (existsSync(file)) {
      try {
        const raw = parseToml(readFileSync(file, 'utf8')) as Record<string, unknown>;
        // `[template.reviewer]` parses as one table named `template`, which is
        // also why "template" is not usable as an agent id.
        const declared = raw.template;
        if (typeof declared === 'object' && declared !== null) {
          for (const [id, v] of Object.entries(declared as Record<string, unknown>)) {
            if (typeof v !== 'object' || v === null) continue;
            const t = v as Record<string, unknown>;
            const agent = typeof t.agent === 'string' ? t.agent : id;
            merged[id] = {
              id,
              description:
                typeof t.description === 'string'
                  ? t.description
                  : (profiles.get(agent)?.description ?? id),
              agent,
              model: typeof t.model === 'string' ? t.model : undefined,
              effort: typeof t.effort === 'string' ? t.effort : undefined,
              prompt: typeof t.prompt === 'string' ? t.prompt : undefined,
              source: 'file',
            };
          }
        }
      } catch (err) {
        console.error(`[templates] ignoring ${file}: ${(err as Error).message}`);
      }
    }

    for (const t of Object.values(merged)) {
      const problem = validate(t, profiles);
      if (problem) t.error = problem;
    }
    return new TemplateRegistry(merged);
  }

  get(id: string): AgentTemplate | null {
    return this.templates[id] ?? null;
  }

  list(): AgentTemplate[] {
    return Object.values(this.templates);
  }

  /** What the browser is given to build the picker from. */
  info(): AgentTemplateInfo[] {
    return this.list().map((t) => ({
      id: t.id,
      description: t.description,
      agent: t.agent,
      model: t.model ?? null,
      effort: t.effort ?? null,
      prompt: t.prompt ?? null,
      error: t.error ?? null,
      source: t.source,
    }));
  }
}
