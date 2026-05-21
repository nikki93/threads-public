import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadRecord } from '../_types';
import { buildCodexLaunch } from './agent-kinds';

test('buildCodexLaunch fresh embeds autoPrompt into seed', () => {
  const launch = buildCodexLaunch({
    thread: {} as ThreadRecord,
    mode: { kind: 'fresh' },
    protocolText: 'protocol text',
    autoPrompt: 'separate auto prompt',
  });

  assert.match(launch.command, /^exec codex\b/);
  assert.match(launch.command, /'protocol text\n\n---\n\nseparate auto prompt'$/);
  assert.equal(launch.sessionId, null);
});

test('buildCodexLaunch fresh without autoPrompt uses protocol only', () => {
  const launch = buildCodexLaunch({
    thread: {} as ThreadRecord,
    mode: { kind: 'fresh' },
    protocolText: 'protocol text',
  });

  assert.match(launch.command, /'protocol text'$/);
  assert.equal(launch.sessionId, null);
});
