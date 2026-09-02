import { describe, expect, it } from 'vitest';
import { buildAgentEnv, shouldStrip, strippedNames } from '../src/agents/env.js';

/**
 * Regression tests for a bug that only appears when the hub is launched from
 * inside another agent CLI: the parent's session variables were inherited by
 * every spawned agent. The visible symptom was "Transcript saving is off —
 * inherited CLAUDE_CODE_CHILD_SESSION marker", which disables the transcript
 * that --resume reads, silently breaking resume.
 */
describe('agent environment sanitizing', () => {
  it('strips the marker that would disable transcripts and break resume', () => {
    expect(shouldStrip('CLAUDE_CODE_CHILD_SESSION')).toBe(true);
    const env = buildAgentEnv({ CLAUDE_CODE_CHILD_SESSION: '1', PATH: '/usr/bin' });
    expect(env).not.toHaveProperty('CLAUDE_CODE_CHILD_SESSION');
    expect(env.PATH).toBe('/usr/bin');
  });

  it("strips the parent's private IPC channel", () => {
    const env = buildAgentEnv({
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    });
    expect(Object.keys(env)).toHaveLength(0);
  });

  it('strips parent session identity', () => {
    for (const name of [
      'CLAUDECODE',
      'CLAUDE_PID',
      'CLAUDE_EFFORT',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_HOST_SESSION_ID',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_AGENT_SDK_VERSION',
      'CLAUDE_PREVIEW_CLASSIFIER_FLOOR',
    ]) {
      expect(shouldStrip(name), name).toBe(true);
    }
  });

  it('passes ordinary user configuration through untouched', () => {
    // Credentials and machine config are the whole reason we inherit at all.
    const base = {
      PATH: '/usr/bin',
      HOME: '/home/k',
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      HTTPS_PROXY: 'http://proxy:8080',
      LANG: 'en_US.UTF-8',
    };
    expect(buildAgentEnv(base)).toEqual(base);
  });

  it('lets a profile override win over a stripped name', () => {
    const env = buildAgentEnv(
      { CLAUDE_CODE_CHILD_SESSION: '1' },
      { CLAUDE_CODE_CHILD_SESSION: 'deliberate' },
    );
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBe('deliberate');
  });

  it('drops undefined values rather than passing "undefined" strings', () => {
    const env = buildAgentEnv({ REAL: 'x', MISSING: undefined });
    expect(env).toEqual({ REAL: 'x' });
  });

  it('reports what it stripped, for diagnostics', () => {
    expect(strippedNames({ PATH: '/usr/bin', CLAUDECODE: '1', CLAUDE_CODE_X: '2' })).toEqual([
      'CLAUDECODE',
      'CLAUDE_CODE_X',
    ]);
  });
});
