import test from 'node:test';
import assert from 'node:assert/strict';
import type { ThreadRecord } from '../_types';
import { threadTerminalEnv } from './terminal-context';

//
// Fixtures
//

function makeThread(): ThreadRecord {
  return {
    id: 'thread-1',
    slug: 'workspace__development',
    fileName: 'workspace__development.md',
    filePath: '/tmp/threads-test/threads/workspace__development.md',
    title: 'development',
    parentId: 'threads',
    note: '# development\n',
    archived: false,
    notify: false,
    depth: 2,
    mtimeMs: 0,
    agents: {},
    convos: { default: { kind: 'claude' } },
    previewOpen: false,
    hasLivePty: false,
    isWorking: false,
    forkParent: false,
  };
}

//
// Tests
//

test('threadTerminalEnv adds thread context without dropping base env', () => {
  const env = threadTerminalEnv(makeThread(), {
    PATH: '/bin',
    EMPTY: undefined,
  });
  assert.equal(env.PATH, '/bin');
  assert.equal('EMPTY' in env, false);
  assert.equal(env.THREAD_ID, 'thread-1');
  assert.equal(env.THREAD_TITLE, 'development');
  assert.equal(env.THREAD_FILE, '/tmp/threads-test/threads/workspace__development.md');
  assert.equal(env.THREADS_DIR, '/tmp/threads-test/threads');
  assert.ok(env.THREADS_PROTOCOL_PATH.endsWith('threads-protocol.md'));
});
