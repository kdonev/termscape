import { readFileSync, existsSync } from 'node:fs';
import { platform } from 'node:process';
import { parse as parseToml } from 'smol-toml';
import type { InjectMode } from '@termscape/protocol';
import { paths } from '../paths.js';

/**
 * An agent profile describes how to launch one kind of CLI and how to talk to
 * it. Adding a new agent CLI should be a config change, not a code change.
 */
export interface AgentProfile {
  id: string;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** false = plain terminal: no MCP wiring, no brief, no agent identity. */
  mcp: boolean;
  /** How busy/idle is determined. */
  status: 'hooks' | 'heuristic';
  /** Regex matched against the last non-empty line when status = heuristic. */
  readyHint?: string;
  inject: InjectMode;
  /**
   * Argument template used to bring a session back with its prior
   * conversation. `{{uuid}}` is replaced with agent_session_uuid. When absent,
   * the profile is not resumable and restarts clean.
   */
  resumeArgs?: string[];
}

function defaultShell(): string {
  if (platform === 'win32') return process.env.COMSPEC ?? 'powershell.exe';
  return process.env.SHELL ?? '/bin/bash';
}

/**
 * Built-in profiles. All Claude Code flags here are verified against the CLI:
 * --mcp-config, --strict-mcp-config, --session-id, --settings,
 * --append-system-prompt-file, --resume.
 */
export const BUILTIN_PROFILES: Record<string, AgentProfile> = {
  claude: {
    id: 'claude',
    description: 'Claude Code, wired to the hub MCP endpoint',
    command: 'claude',
    args: [
      '--mcp-config',
      '{{mcp_config_path}}',
      '--strict-mcp-config',
      '--session-id',
      '{{session_uuid}}',
      '--settings',
      '{{settings_path}}',
      '--append-system-prompt-file',
      '{{brief_path}}',
    ],
    env: {},
    mcp: true,
    status: 'hooks',
    inject: 'bracketed',
    // Resume swaps --session-id for --resume; everything else is re-templated
    // identically, and crucially the session is relaunched in the same cwd,
    // because Claude Code keys its conversation store by working directory.
    resumeArgs: [
      '--mcp-config',
      '{{mcp_config_path}}',
      '--strict-mcp-config',
      '--resume',
      '{{session_uuid}}',
      '--settings',
      '{{settings_path}}',
      '--append-system-prompt-file',
      '{{brief_path}}',
    ],
  },
  shell: {
    id: 'shell',
    description: 'Plain terminal, no agent wiring',
    command: defaultShell(),
    args: [],
    env: {},
    mcp: false,
    status: 'heuristic',
    readyHint: '[$#>%] ?$',
    inject: 'raw',
  },
};

export class ProfileRegistry {
  private profiles: Record<string, AgentProfile>;

  constructor(profiles?: Record<string, AgentProfile>) {
    this.profiles = profiles ?? { ...BUILTIN_PROFILES };
  }

  /** Built-ins, overlaid with ~/.termscape/agents.toml if present. */
  static load(): ProfileRegistry {
    const merged: Record<string, AgentProfile> = { ...BUILTIN_PROFILES };
    const file = paths.profiles();
    if (existsSync(file)) {
      try {
        const raw = parseToml(readFileSync(file, 'utf8')) as Record<string, any>;
        for (const [id, v] of Object.entries(raw)) {
          if (typeof v !== 'object' || v === null) continue;
          const base = merged[id];
          merged[id] = {
            id,
            description: v.description ?? base?.description ?? id,
            command: v.command ?? base?.command ?? id,
            args: v.args ?? base?.args ?? [],
            env: v.env ?? base?.env ?? {},
            mcp: v.mcp ?? base?.mcp ?? true,
            status: v.status ?? base?.status ?? 'heuristic',
            readyHint: v.ready_hint ?? v.readyHint ?? base?.readyHint,
            inject: v.inject ?? base?.inject ?? 'bracketed',
            resumeArgs: v.resume_args ?? v.resumeArgs ?? base?.resumeArgs,
          };
        }
      } catch (err) {
        // A broken config must not take the hub down; fall back to built-ins.
        console.error(`[profiles] ignoring ${file}: ${(err as Error).message}`);
      }
    }
    return new ProfileRegistry(merged);
  }

  get(id: string): AgentProfile | null {
    return this.profiles[id] ?? null;
  }

  require(id: string): AgentProfile {
    const p = this.get(id);
    if (!p) throw new Error(`unknown agent profile "${id}"`);
    return p;
  }

  list(): AgentProfile[] {
    return Object.values(this.profiles);
  }

  isResumable(id: string): boolean {
    const p = this.get(id);
    return !!p?.resumeArgs;
  }
}

/** Replace `{{key}}` placeholders. Unknown placeholders are left untouched. */
export function template(input: string, vars: Record<string, string>): string {
  return input.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    key in vars ? vars[key]! : whole,
  );
}

export function templateAll(args: string[], vars: Record<string, string>): string[] {
  return args.map((a) => template(a, vars));
}
