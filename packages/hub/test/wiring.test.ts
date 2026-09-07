import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_PROFILES, templateAll } from '../src/agents/profiles.js';
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

describe('what stays a plain terminal', () => {
  it('leaves opencode unwired, because wiring it means writing to the user', () => {
    // `opencode mcp add` mutates its own config and there is no per-run
    // equivalent, so wiring it means editing a file the user owns and undoing
    // that even when the hub was killed rather than stopped. A profile that
    // claimed wiring it does not have would be worse than one that says
    // plainly it is a terminal.
    expect(BUILTIN_PROFILES.opencode!.mcp).toBe(false);
    expect(BUILTIN_PROFILES.shell!.mcp).toBe(false);
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
