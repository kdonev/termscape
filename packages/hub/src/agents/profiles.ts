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

  /* ------------------------------------------------------ detection */

  /**
   * How to ask this CLI its version. Its stdout is shown to the user and is
   * also the cache key for the model list, so a CLI that updates underneath
   * us re-lists rather than serving last week's answer.
   */
  versionArgs?: string[];
  /**
   * How to ask this CLI what models it can be pointed at: one
   * `provider/model` (or bare name) per line on stdout. Absent when the CLI
   * has no such command, which is the common case.
   */
  modelsArgs?: string[];
  /**
   * The answer for a CLI that cannot be asked. Claude Code is the example:
   * it has no listing command, and its --help documents the aliases instead.
   * Used only when `modelsArgs` is absent or its command fails.
   */
  models?: string[];

  /* ------------------------------------------------------- templates */

  /**
   * How this agent spells a model on the command line. `{{model}}` carries
   * the value a template chose.
   *
   * A template holds *values*, not argv, because no two of these agents agree:
   * Claude Code takes `--model`, opencode takes `-m provider/model`. So the
   * template says which model and the agent says how to write it down.
   *
   * Absent means the agent takes no model here, and a template that names one
   * for it is a configuration error reported at load rather than a flag
   * silently dropped at launch. The whole fragment disappears when a template
   * leaves the value unset - it does not expand to an empty string.
   */
  modelArgs?: string[];
  /** The same for effort, with `{{effort}}`. */
  effortArgs?: string[];
  /** The effort levels this agent documents, for the dialog to offer. */
  efforts?: string[];
}

function defaultShell(): string {
  if (platform === 'win32') return process.env.COMSPEC ?? 'powershell.exe';
  return process.env.SHELL ?? '/bin/bash';
}

/**
 * Built-in profiles. All Claude Code flags here are verified against the CLI:
 * --mcp-config, --strict-mcp-config, --session-id, --settings,
 * --append-system-prompt-file, --resume.
 *
 * The other three are deliberately `mcp: false` - a terminal on the canvas
 * running that CLI, with no hub wiring. Each of them configures MCP servers
 * its own way and none of those ways has been verified here, and a profile
 * that claims agent wiring it does not have is worse than one that says
 * plainly it is a terminal. Detection still finds them, reports their version
 * and lists their models, which is what this file is mostly for.
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
    versionArgs: ['--version'],
    /*
     * Claude Code has no listing command, so this is the declared half of
     * "ask where you can, declare where you cannot". Exactly the aliases
     * `claude --help` names for --model; a full name like `claude-fable-5` is
     * accepted too, which is why a template must not be limited to this list.
     */
    models: ['fable', 'opus', 'sonnet'],
    // Both verified against `claude --help`: --model takes an alias or a full
    // name, --effort takes low, medium, high, xhigh or max.
    modelArgs: ['--model', '{{model}}'],
    effortArgs: ['--effort', '{{effort}}'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
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
  opencode: {
    id: 'opencode',
    description: 'opencode TUI — no hub wiring; it configures MCP its own way',
    command: 'opencode',
    // Bare, which is its default subcommand and starts the TUI. `run` is the
    // one-shot form and is not what a window on the canvas wants.
    args: [],
    env: {},
    mcp: false,
    status: 'heuristic',
    inject: 'bracketed',
    versionArgs: ['--version'],
    // Real enumeration: one provider/model per line, 395 of them on the
    // machine this was written on.
    modelsArgs: ['models'],
    // `-m provider/model` is a top-level option, so it applies to the TUI and
    // not only to `run`. Verified against `opencode --help`.
    modelArgs: ['-m', '{{model}}'],
    // No effortArgs on purpose: `--variant` is documented under `opencode run`
    // and is not a top-level option, so the TUI this profile starts does not
    // take one. A template asking for an effort here is refused at load.
  },
  codex: {
    id: 'codex',
    description: 'Codex CLI — no hub wiring yet; its flags are unverified',
    command: 'codex',
    args: [],
    env: {},
    mcp: false,
    status: 'heuristic',
    inject: 'bracketed',
    versionArgs: ['--version'],
  },
  gemini: {
    id: 'gemini',
    description: 'Gemini CLI — no hub wiring yet; its flags are unverified',
    command: 'gemini',
    args: [],
    env: {},
    mcp: false,
    status: 'heuristic',
    inject: 'bracketed',
    versionArgs: ['--version'],
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
    // Nothing to detect: it is whatever COMSPEC or SHELL points at, it is
    // always there, and asking a shell its version means something different
    // on every platform.
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
          // `[template.reviewer]` parses as one table named `template`, and it
          // belongs to TemplateRegistry rather than here.
          if (id === 'template') continue;
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
            versionArgs: v.version_args ?? v.versionArgs ?? base?.versionArgs,
            modelsArgs: v.models_args ?? v.modelsArgs ?? base?.modelsArgs,
            models: v.models ?? base?.models,
            modelArgs: v.model_args ?? v.modelArgs ?? base?.modelArgs,
            effortArgs: v.effort_args ?? v.effortArgs ?? base?.effortArgs,
            efforts: v.efforts ?? base?.efforts,
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
