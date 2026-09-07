import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
});
