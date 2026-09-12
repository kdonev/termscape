import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  briefMode,
  BUILTIN_PROFILES,
  templateAll,
  type AgentProfile,
} from '../src/agents/profiles.js';
import { writeWiring } from '../src/agents/wiring.js';
import { removeTree } from './tmp.js';

/*
 * How Codex and Gemini reach the hub.
 *
 * Everything asserted here was verified against the CLI actually installed -
 * codex-cli 0.153.4 and gemini 0.58.0 - and the point of pinning it is that
 * the previous profiles for these two were written from memory and were
 * wrong. If one of these assertions has to change, it should be because
 * somebody went and checked again, not because it started failing.
 *
 * These are declarations rather than launches on purpose: a test that spawns
 * the real CLI only passes on a machine that has it.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termscape-wiring-'));
  process.env.TERMSCAPE_HOME = dir;
});

afterEach(() => {
  delete process.env.TERMSCAPE_HOME;
  removeTree(dir);
});

const HUB = 'http://127.0.0.1:4321';
const TOKEN = 'tok-abcdef';

const wire = () =>
  writeWiring({
    sessionId: 'sess-1',
    address: 'crew/scout',
    workspace: 'crew',
    cwd: dir,
    profile: BUILTIN_PROFILES.claude!,
    token: TOKEN,
    hubOrigin: HUB,
    peers: [],
  });

/** The vars the session manager expands a profile's args and env against. */
const varsFor = (w: ReturnType<typeof wire>) => ({
  mcp_config_path: w.mcpConfigPath,
  settings_path: w.settingsPath,
  brief_path: w.briefPath,
  gemini_settings_path: w.geminiSettingsPath,
  opencode_config: w.opencodeConfig,
  kilocode_config_path: w.kilocodeConfigPath,
  mcp_url: `${HUB}/mcp`,
  token: TOKEN,
});

describe('codex', () => {
  const codex = BUILTIN_PROFILES.codex!;

  it('declares the MCP server in argv, for one run, touching no config file', () => {
    const argv = templateAll(codex.args, varsFor(wire()));
    // Exactly the table `codex mcp add --url` writes into config.toml, except
    // it lives for this invocation. The value after `=` is parsed as TOML,
    // hence the quotes around the URL.
    expect(argv).toEqual([
      '-c',
      `mcp_servers.termscape.url="${HUB}/mcp"`,
      '-c',
      'mcp_servers.termscape.bearer_token_env_var="TERMSCAPE_TOKEN"',
    ]);
  });

  it('keeps the bearer token out of the command line', () => {
    const vars = varsFor(wire());
    const argv = templateAll(codex.args, vars);
    // `-c` values land in the process command line, where any other user on
    // the machine can read them. `bearer_token_env_var` exists precisely so
    // the token does not have to go there.
    expect(argv.join(' ')).not.toContain(TOKEN);
    expect(templateAll([codex.env.TERMSCAPE_TOKEN!], vars)).toEqual([TOKEN]);
  });

  it('spells model as a flag and effort as a config key', () => {
    // Codex has no --effort. Reasoning depth is a config key and takes the
    // same -c route as the MCP server.
    expect(codex.modelArgs).toEqual(['-m', '{{model}}']);
    expect(codex.effortArgs).toEqual(['-c', 'model_reasoning_effort="{{effort}}"']);
    expect(codex.efforts).toContain('xhigh');
  });

  it('is wired, is briefed by being typed at, and is not resumable', () => {
    expect(codex.mcp).toBe(true);
    // base_instructions replaces Codex's own system prompt rather than adding
    // to it, so the brief cannot ride in on a flag.
    expect(codex.brief).toBe('typed');
    // `codex resume` wants an id Codex mints itself and will not accept one
    // from us, so there is nothing to record at start.
    expect(codex.resumeArgs).toBeUndefined();
  });
});

describe('gemini', () => {
  const gemini = BUILTIN_PROFILES.gemini!;

  it('reaches its MCP config through the system settings layer', () => {
    const w = wire();
    // There is no --mcp-config equivalent; this env var is the only per-run
    // way in, and it points at a file the hub owns rather than the user's.
    expect(templateAll([gemini.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!], varsFor(w))).toEqual([
      w.geminiSettingsPath,
    ]);
    expect(w.geminiSettingsPath).not.toContain('.gemini');
  });

  it('writes the server the way `gemini mcp add` writes one', () => {
    const w = wire();
    const server = JSON.parse(readFileSync(w.geminiSettingsPath, 'utf8')).mcpServers.termscape;
    expect(server.url).toBe(`${HUB}/mcp`);
    expect(server.type).toBe('http');
    expect(server.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // A server Gemini gives up on is reported as merely "Disconnected", which
    // reads exactly like a hub that is not running.
    expect(server.timeout).toBeGreaterThanOrEqual(30_000);
  });

  it('trusts the workspace for the session instead of disabling the check', () => {
    // Gemini refuses to start MCP servers in an untrusted folder, and says so
    // only as a warning - the agent would come up looking fine with no tools.
    expect(gemini.args).toContain('--skip-trust');
    const settings = JSON.parse(readFileSync(wire().geminiSettingsPath, 'utf8'));
    expect(settings.security).toBeUndefined();
  });

  it('takes a model but no effort', () => {
    expect(gemini.modelArgs).toEqual(['-m', '{{model}}']);
    // `gemini --help` documents no reasoning-effort option, so a template
    // naming one is refused at load rather than dropped at launch.
    expect(gemini.effortArgs).toBeUndefined();
  });

  it('is wired, is briefed by being typed at, and is not resumable', () => {
    expect(gemini.mcp).toBe(true);
    // GEMINI_SYSTEM_MD replaces the core system prompt rather than appending
    // to it, so it is not a way to deliver a brief.
    expect(gemini.brief).toBe('typed');
    // --session-id does take a UUID of our choosing, but --resume takes
    // "latest" or an index into a list, never that UUID.
    expect(gemini.resumeArgs).toBeUndefined();
  });
});

describe('opencode', () => {
  const opencode = BUILTIN_PROFILES.opencode!;

  it('is configured entirely from the environment, writing no file at all', () => {
    const w = wire();
    // The assumption that opencode had no per-run route came from reading
    // `opencode mcp add` - which does write to ~/.config/opencode/opencode.json
    // and ignores OPENCODE_CONFIG while doing it - and taking that command for
    // the only way in. This variable is the way in, and it writes nothing.
    const cfg = JSON.parse(
      templateAll([opencode.env.OPENCODE_CONFIG_CONTENT!], varsFor(w))[0]!,
    );
    expect(cfg.mcp.termscape).toEqual({
      type: 'remote',
      url: `${HUB}/mcp`,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  });

  it('is wired and briefed by being typed at', () => {
    expect(opencode.mcp).toBe(true);
    expect(opencode.brief).toBe('typed');
  });

  it('probes without leaving a config file in the user’s home', () => {
    // `opencode models` writes ~/.config/opencode/opencode.jsonc when it finds
    // no config at all, and detection runs on machines whose owner may never
    // have run opencode by hand. An empty config is still a config.
    expect(opencode.probeEnv).toEqual({ OPENCODE_CONFIG_CONTENT: '{}' });
  });
});

describe('kilocode', () => {
  const kilocode = BUILTIN_PROFILES.kilocode!;

  it('starts the TUI bare and carries everything in one layered config file', () => {
    const w = wire();
    // No flags at all. Every invented flag this profile could have taken was
    // checked against `kilo --help` and `kilo run --help`; the ones that
    // exist are on `run`, not on the TUI.
    expect(kilocode.args).toEqual([]);
    expect(templateAll([kilocode.env.KILO_CONFIG!], varsFor(w))).toEqual([w.kilocodeConfigPath]);
    expect(w.kilocodeConfigPath).toContain('sess-1');
  });

  it('names the brief under instructions, having no flag that appends one', () => {
    // Kilo's top-level parser is not strict: `--append-system-prompt-file`
    // is accepted, ignored and exits 0, so an agent briefed that way would
    // launch with no brief and no error. `instructions` is the real route.
    const w = wire();
    const cfg = JSON.parse(readFileSync(w.kilocodeConfigPath, 'utf8'));
    expect(cfg.instructions).toEqual([w.briefPath]);
    expect(kilocode.args.join(' ')).not.toContain('append-system-prompt');
    // Still `flag` rather than `typed`: the brief is in the system prompt
    // before the first turn, which is what the value promises.
    expect(briefMode(kilocode)).toBe('flag');
  });

  it('keeps the bearer token out of the config file and in the environment', () => {
    const w = wire();
    const raw = readFileSync(w.kilocodeConfigPath, 'utf8');
    const cfg = JSON.parse(raw);
    expect(cfg.mcp.termscape.type).toBe('remote');
    expect(cfg.mcp.termscape.url).toBe(`${HUB}/mcp`);
    // `{env:...}` is Kilo's own substitution, so the file names the variable
    // and never the secret - and the variable has to actually be exported,
    // which is the half that is easy to forget.
    expect(cfg.mcp.termscape.headers.Authorization).toBe('Bearer {env:TERMSCAPE_TOKEN}');
    expect(raw).not.toContain(TOKEN);
    expect(templateAll([kilocode.env.TERMSCAPE_TOKEN!], varsFor(w))).toEqual([TOKEN]);
  });

  it('leaves the user config alone rather than merging it in', () => {
    // `KILO_CONFIG` is appended last to the list Kilo already layers, and the
    // layers are deep-merged. Copying the user's config into ours would only
    // repeat what Kilo does - and would duplicate their instruction files,
    // because instruction lists concatenate across layers.
    writeFileSync(
      join(dir, 'kilo.json'),
      JSON.stringify({ model: 'kilo/~anthropic/claude-opus-latest', instructions: ['USER.md'] }),
    );

    const cfg = JSON.parse(readFileSync(wire().kilocodeConfigPath, 'utf8'));
    expect(cfg.model).toBeUndefined();
    expect(cfg.instructions).not.toContain('USER.md');
    expect(Object.keys(cfg).sort()).toEqual(['instructions', 'mcp']);
  });

  it('probes without leaving a config file behind', () => {
    // The opposite variable, and the opposite meaning: KILO_CONFIG_CONTENT
    // replaces the effective config instead of layering onto it. Wrong for a
    // session, right for a probe on a machine whose owner may never have run
    // Kilo by hand.
    expect(kilocode.probeEnv).toEqual({ KILO_CONFIG_CONTENT: '{}' });
  });

  it('asks the CLI for its models rather than declaring a list', () => {
    // `kilo models` prints one provider/model per line, the same shape
    // opencode answers with, so detection reads it directly.
    expect(kilocode.modelsArgs).toEqual(['models']);
    expect(kilocode.models).toBeUndefined();
    expect(kilocode.modelArgs).toEqual(['-m', '{{model}}']);
  });

  it('takes no effort and is not resumable, and says so by declaring neither', () => {
    // `--variant` lives under `kilo run`, not on the TUI - the same split
    // opencode has. A template asking for an effort is refused at load.
    expect(kilocode.effortArgs).toBeUndefined();
    expect(kilocode.efforts).toBeUndefined();
    // `--session` wants an id Kilo mints itself, and `--continue` resolves to
    // the newest session in the cwd, which is the wrong agent once a
    // workspace holds two.
    expect(kilocode.resumeArgs).toBeUndefined();
  });

  it('writes no config at all for a profile that is not wired', () => {
    const unwired = { ...kilocode, id: 'plain', mcp: false, brief: 'typed' as const };
    const w = writeWiring({
      sessionId: 'sess-3',
      address: 'crew/plain',
      workspace: 'crew',
      cwd: dir,
      profile: unwired,
      token: TOKEN,
      hubOrigin: HUB,
      peers: [],
    });
    expect(existsSync(w.kilocodeConfigPath)).toBe(false);
  });
});

describe('what stays a plain terminal', () => {
  it('leaves shell alone, and says so rather than relying on the default', () => {
    // The one profile where being typed at is actively harmful: a shell runs
    // what it is given, so a brief there is a series of failing commands.
    expect(BUILTIN_PROFILES.shell!.mcp).toBe(false);
    expect(BUILTIN_PROFILES.shell!.brief).toBe('none');
  });

  it('defaults an unwired profile to no brief, so a declared terminal stays one', () => {
    // `mcp: false` has always meant "a plain terminal". Someone who declared
    // one should not find text being typed into it after an upgrade; an
    // unwired agent that is an agent opts in with brief = "typed".
    expect(briefMode({ mcp: false } as AgentProfile)).toBe('none');
    expect(briefMode({ mcp: true } as AgentProfile)).toBe('flag');
    expect(briefMode({ mcp: false, brief: 'typed' } as AgentProfile)).toBe('typed');
  });
});

describe('the brief an unwired agent gets', () => {
  /** An agent CLI with no MCP support, the way a user would declare one. */
  const unwired = {
    ...BUILTIN_PROFILES.opencode!,
    id: 'plain',
    mcp: false,
    brief: 'typed' as const,
  };

  const wireUnwired = () =>
    writeWiring({
      sessionId: 'sess-2',
      address: 'crew/plain',
      workspace: 'crew',
      cwd: dir,
      profile: unwired,
      token: TOKEN,
      hubOrigin: HUB,
      peers: ['crew/other'],
    });

  it('tells it its address and what a [from ...] line is', () => {
    const brief = readFileSync(wireUnwired().briefPath, 'utf8');
    expect(brief).toContain('crew/plain');
    expect(brief).toContain('[from <address>]');
    // The paragraph that matters most: without it a peer's instruction reads
    // as the human's own.
    expect(brief).toContain('a request from a peer');
  });

  it('promises no tools, because it has none', () => {
    const brief = readFileSync(wireUnwired().briefPath, 'utf8');
    for (const tool of ['send_message', 'list_agents', 'spawn_agent', 'whoami']) {
      expect(brief).not.toContain(tool);
    }
  });

  it('names no peers, because it could never refresh the list', () => {
    // A list frozen at launch is wrong the moment a second agent starts, and
    // it would be the only picture this agent ever had.
    expect(readFileSync(wireUnwired().briefPath, 'utf8')).not.toContain('crew/other');
  });

  it('is given no MCP config naming tools it cannot call', () => {
    const w = wireUnwired();
    expect(existsSync(w.mcpConfigPath)).toBe(false);
    expect(existsSync(w.geminiSettingsPath)).toBe(false);
    expect(existsSync(w.briefPath)).toBe(true);
  });
});

describe('the brief', () => {
  it('is written once and read back, whichever way it travels', () => {
    const w = wire();
    const brief = readFileSync(w.briefPath, 'utf8');
    expect(brief).toContain('crew/scout');
    expect(brief).toContain('send_message');
    // Claude Code's own path is unchanged: its argv still names the file.
    expect(BUILTIN_PROFILES.claude!.args).toContain('{{brief_path}}');
    expect(BUILTIN_PROFILES.claude!.brief).toBeUndefined();
  });

  it('says answering in your own output does not reach the asker', () => {
    /*
     * An opencode agent was messaged, called termscape_whoami, then wrote the
     * answer into its own terminal and stopped. It had the tool and the
     * connection; nothing had told it that the terminal it was writing into is
     * read by the human and by nobody else, so it believed it had replied.
     */
    const brief = readFileSync(wire().briefPath, 'utf8');
    expect(brief).toMatch(/does not reply/);
    expect(brief).toMatch(/still unanswered/);
    // And the tool is not called `send_message` in any client that shows it:
    // opencode prefixes it, Claude Code mangles it differently again.
    expect(brief).toMatch(/termscape_send_message/);
    expect(brief).toMatch(/mcp__termscape__send_message/);
    expect(brief).toMatch(/on the ending rather than looking for the exact name/);
  });

  it('says a template is made with the tool, not by editing a checkout', () => {
    /*
     * Asked "can you add templates to termscape", an agent that had the tool
     * went looking for the source code instead - a fair reading of "add X to
     * Y", and the brief did nothing to correct it because it described the
     * tool as something the agent offers rather than something a human asks
     * for. The commonest case is the human asking.
     */
    const brief = readFileSync(wire().briefPath, 'utf8');
    expect(brief).toContain('propose_template');
    expect(brief).toMatch(/asks you to add, create or save a template/);
    expect(brief).toMatch(/not to go and edit Termscape's own source code/);
  });
});
