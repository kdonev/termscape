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
   * How the brief reaches the agent.
   *
   * `flag` - the profile's own args point at `{{brief_path}}`, the way Claude
   * Code's `--append-system-prompt-file` does. The brief is part of the
   * system prompt and the agent never sees it as a turn.
   *
   * `typed` - the CLI has no way to *append* to its system prompt, so the
   * brief is typed into the terminal once the CLI is up, ahead of any opening
   * instruction. Both of the other wired CLIs are in this position, and for
   * the same reason: Codex's `base_instructions` and Gemini's
   * `GEMINI_SYSTEM_MD` each *replace* the whole system prompt rather than add
   * to it, so using either would cost the agent its own tool instructions -
   * a far worse trade than a first turn that arrives as text.
   *
   * `none` - nothing is sent. `shell` is the reason this value exists and it
   * is not a value any agent should want: a shell *executes* what is typed at
   * it, so a brief there is not context, it is a series of commands that fail
   * loudly.
   *
   * Absent means `flag` for a wired agent - what every profile written before
   * this did - and `none` for an unwired one, because `mcp: false` has always
   * meant "a plain terminal" and a profile that declared one should not start
   * having text typed into it. An unwired agent that *is* an agent says
   * `brief = "typed"` and gets the shorter brief: no tool list, because it has
   * no tools, but it is still told its address and still told that a
   * `[from ...]` line is a colleague rather than the human.
   */
  brief?: 'flag' | 'typed' | 'none';
  /**
   * Argument template used to bring a session back with its prior
   * conversation. `{{uuid}}` is replaced with agent_session_uuid. When absent,
   * the profile is not resumable and restarts clean.
   */
  resumeArgs?: string[];

  /* ------------------------------------------------------ detection */

  /**
   * Environment for the *detection* probes only, not for a session.
   *
   * Detection runs these CLIs on a machine whose owner may never have run them
   * by hand, so a probe that leaves something behind is the hub writing to
   * somebody's home directory uninvited. `opencode models` does exactly that -
   * it creates ~/.config/opencode/opencode.jsonc - and this is how it is told
   * not to.
   */
  probeEnv?: Record<string, string>;
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
 * --mcp-config, --session-id, --settings, --append-system-prompt-file,
 * --resume.
 *
 * `--mcp-config` deliberately arrives *without* `--strict-mcp-config`. Strict
 * mode makes the named file the whole of the agent's MCP configuration, which
 * silently drops every server the user set up for themselves — an agent
 * started here would be missing the tools it has everywhere else, with nothing
 * on screen to say why. Without it the hub's server is one more entry beside
 * theirs, which is the only version of "wired to the hub" worth having.
 *
 * Codex and Gemini are wired too, and every flag and key below was verified
 * against the CLI actually installed - codex-cli 0.153.4 and gemini 0.58.0 -
 * rather than written from memory. Both reach the hub the same way Claude
 * Code does, over one streamable-HTTP MCP server carrying a bearer token, and
 * neither needs a byte written to config the user owns:
 *
 * - **Codex** takes `-c <dotted.key>=<toml>` on any invocation, so the server
 *   is declared in argv for the one run. The token is *not* in argv - it goes
 *   in the environment, and `bearer_token_env_var` names the variable to read
 *   it from, which keeps it out of every process listing on the machine.
 * - **Gemini** has no per-run config flag, but
 *   `GEMINI_CLI_SYSTEM_SETTINGS_PATH` repoints its system settings layer at a
 *   file of our choosing, which the hub generates per session.
 *
 * - **opencode** turned out to be the least invasive of the three and was
 *   assumed to be the hardest. It reads its entire config from
 *   `OPENCODE_CONFIG_CONTENT`, so nothing is written anywhere at all, and what
 *   it is given is merged with the user's own config rather than replacing it.
 *   The assumption that it had no per-run route came from reading
 *   `opencode mcp add` - which does write to the user's file, and ignores
 *   `OPENCODE_CONFIG` when it does - and mistaking that command for the only
 *   way in.
 *
 * `shell` and `powershell` are the two profiles left that are not agents, and
 * they are not agents in a way no flag can fix: they run a shell, so text
 * typed at one is executed rather than read.
 */
export const BUILTIN_PROFILES: Record<string, AgentProfile> = {
  claude: {
    id: 'claude',
    description: 'Claude Code, wired to the hub MCP endpoint',
    command: 'claude',
    args: [
      '--mcp-config',
      '{{mcp_config_path}}',
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
    description: 'opencode TUI, wired to the hub MCP endpoint',
    command: 'opencode',
    // Bare, which is its default subcommand and starts the TUI. `run` is the
    // one-shot form and is not what a window on the canvas wants.
    args: [],
    /*
     * The least invasive of the four, and the one that was assumed hardest.
     * opencode reads its whole config from this variable, so there is no file
     * anywhere - not even one of ours - and it is *merged* with the user's own
     * config rather than replacing it, so their models, themes and their own
     * MCP servers survive the session.
     *
     * Note what this deliberately does not use: `opencode mcp add` writes to
     * ~/.config/opencode/opencode.json and ignores OPENCODE_CONFIG while doing
     * it. Setting this variable also stops opencode writing its default config
     * file on start, so a session leaves nothing behind at all.
     */
    env: { OPENCODE_CONFIG_CONTENT: '{{opencode_config}}' },
    // `opencode models` writes ~/.config/opencode/opencode.jsonc when it finds
    // no config at all, and detection runs on machines whose owner may never
    // have run opencode by hand. An empty config is still a config, so this
    // suppresses that without changing what the probe reports.
    probeEnv: { OPENCODE_CONFIG_CONTENT: '{}' },
    mcp: true,
    brief: 'typed',
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
    description: 'Codex CLI, wired to the hub MCP endpoint',
    command: 'codex',
    /*
     * Bare, which starts the interactive TUI - `exec` is the one-shot form and
     * is not what a window on the canvas wants.
     *
     * The two `-c` overrides are exactly the table `codex mcp add --url` would
     * have written into ~/.codex/config.toml, except they live for one run and
     * touch nothing. The value after `=` is parsed as TOML, which is why the
     * URL is quoted.
     */
    args: [
      '-c',
      'mcp_servers.termscape.url="{{mcp_url}}"',
      '-c',
      'mcp_servers.termscape.bearer_token_env_var="TERMSCAPE_TOKEN"',
    ],
    // The token is named here rather than written into argv: `-c` values land
    // in the process command line, where every other user on the machine can
    // read them.
    env: { TERMSCAPE_TOKEN: '{{token}}' },
    mcp: true,
    brief: 'typed',
    status: 'heuristic',
    inject: 'bracketed',
    versionArgs: ['--version'],
    /*
     * `codex debug models` does render the real catalog, but it is a debug
     * command by its own description and it answers with 500KB of JSON that
     * also carries every model's system prompt - not the one-per-line stdout
     * `modelsArgs` reads. So this is the declared half of "ask where you can,
     * declare where you cannot": the slugs that catalog marks
     * `visibility: "list"`. A full name not in this list is still accepted,
     * which is why a template must not be limited to it.
     */
    models: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2'],
    modelArgs: ['-m', '{{model}}'],
    /*
     * Codex has no `--effort`; reasoning depth is a config key, and it takes
     * the same `-c` route as the MCP server above. Verified by reading it back
     * off the `reasoning effort:` line of the session header.
     *
     * The levels are the union of `supported_reasoning_levels` across the
     * listed models. They are per model in the catalog and Codex forwards
     * whatever it is given without checking, so this list is what the dialog
     * offers and never a limit the hub enforces.
     */
    effortArgs: ['-c', 'model_reasoning_effort="{{effort}}"'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    /*
     * No resumeArgs, and not an oversight. `codex resume` takes a session id,
     * but Codex mints that id itself and offers no way to be handed one, so
     * the hub cannot record up front what it would have to ask for later.
     * `--last` is the alternative and it resolves to "the most recent session
     * in this cwd", which is the wrong agent as soon as a workspace holds two
     * of them. Better to say plainly it restarts clean.
     */
  },
  gemini: {
    id: 'gemini',
    description: 'Gemini CLI, wired to the hub MCP endpoint',
    command: 'gemini',
    /*
     * Gemini refuses to start MCP servers in a folder it does not trust, and
     * says so only as a warning on stderr - the agent would come up looking
     * fine with no tools. `--skip-trust` trusts the workspace for this session
     * and writes nothing; the alternative, turning folder trust off in the
     * settings file below, would disable the check for everything else too.
     */
    args: ['--skip-trust'],
    // No `--mcp-config` equivalent exists. This repoints the *system* settings
    // layer - normally a machine-wide file - at the per-session one the hub
    // generates, so ~/.gemini/settings.json is never opened, let alone written.
    env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: '{{gemini_settings_path}}' },
    mcp: true,
    brief: 'typed',
    status: 'heuristic',
    inject: 'bracketed',
    versionArgs: ['--version'],
    // Declared: there is no `gemini models`. These are the model constants the
    // CLI itself names, minus the ones it uses internally for embeddings and
    // its visual agent, which are not things to point an agent window at.
    models: [
      'gemini-3.1-pro-preview',
      'gemini-3-pro-preview',
      'gemini-3.5-flash',
      'gemini-3-flash',
      'gemini-3.1-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ],
    modelArgs: ['-m', '{{model}}'],
    /*
     * No effortArgs: `gemini --help` documents no reasoning-effort option, so
     * a template naming one for this agent is refused at load rather than
     * dropped at launch.
     *
     * No resumeArgs either, for a narrower reason than Codex's. `--session-id`
     * does accept a UUID of our choosing, but `--resume` takes "latest" or an
     * index into a list - never that UUID - so the id the hub could record is
     * not an id it could resume by.
     */
  },
  /*
   * PowerShell, named rather than left to `shell`.
   *
   * On Windows `shell` follows COMSPEC, which is cmd.exe - so the shell most
   * Windows work actually happens in was the one thing the picker could not
   * offer. Elsewhere `pwsh` is the cross-platform build, and it stays in the
   * list when it is not installed with "not found on PATH" against it, which
   * is the honest answer for a shell you have to install.
   *
   * Unwired for the same reason `shell` is, and it is not a gap a flag could
   * close: a shell executes what is typed at it, so a brief there is a series
   * of commands rather than context.
   */
  powershell: {
    id: 'powershell',
    description: 'PowerShell, no agent wiring',
    command: platform === 'win32' ? 'powershell.exe' : 'pwsh',
    // -NoLogo: the banner is three lines of nothing in a window this small.
    args: ['-NoLogo'],
    env: {},
    mcp: false,
    brief: 'none',
    status: 'heuristic',
    // `PS C:\dev>`, and the `>>` of a continuation prompt. Not a bare `>`,
    // which is the last character of half the redirects anyone types.
    readyHint: '(PS [^>]*>|^>>) ?$',
    inject: 'raw',
    // Asked rather than declared: unlike `shell`, which is whatever COMSPEC or
    // SHELL happens to point at, this is one named command that either is on
    // PATH or is not - and its version is worth showing next to it.
    versionArgs: ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
  },
  shell: {
    id: 'shell',
    description: 'Plain terminal, no agent wiring',
    command: defaultShell(),
    args: [],
    env: {},
    mcp: false,
    // Said out loud rather than left to the default, because this is the one
    // profile where being typed at is actively harmful: a shell runs what it
    // is given. It can still be *sent* a message - the router writes to any
    // running window - and that is the human's business, not the hub's.
    brief: 'none',
    status: 'heuristic',
    readyHint: '[$#>%] ?$',
    inject: 'raw',
    // Nothing to detect: it is whatever COMSPEC or SHELL points at, it is
    // always there, and asking a shell its version means something different
    // on every platform.
  },
};

/**
 * How this profile's brief travels, with the defaults applied.
 *
 * One place, because three callers need the same answer and the interesting
 * part is the default rather than the field: absent means `flag` for a wired
 * agent and `none` for an unwired one.
 */
export function briefMode(p: AgentProfile): 'flag' | 'typed' | 'none' {
  return p.brief ?? (p.mcp ? 'flag' : 'none');
}

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
            brief: v.brief ?? base?.brief,
            resumeArgs: v.resume_args ?? v.resumeArgs ?? base?.resumeArgs,
            probeEnv: v.probe_env ?? v.probeEnv ?? base?.probeEnv,
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
