import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

//
// Isolated Module
//

const tempRoot = mkdtempSync(join(tmpdir(), 'threads-store-'));
process.env.THREADS_DIR = join(tempRoot, 'threads');
process.env.THREADS_DEFAULT_CWD = tempRoot;

let store = null as unknown as typeof import('./thread-store');

test.before(async () => {
  store = await import('./thread-store');
});

test.after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

test.beforeEach(() => {
  rmSync(store.THREADS_DIR, { recursive: true, force: true });
  store.ensureThreadsDir();
});

//
// Tests
//

test('updateThread persists an intentional empty note', () => {
  const thread = store.createThread({
    title: 'empty me',
    note: '# empty me\n\nbody\n',
  });
  const updated = store.updateThread(thread.id, { note: '' });

  assert.equal(updated?.note, '');
  assert.match(readFileSync(thread.filePath, 'utf8'), /\n---\n$/);
});

test('listThreadFiles ignores malformed files without hiding valid threads', () => {
  const thread = store.createThread({ title: 'valid', note: '# valid\n' });
  writeFileSync(join(store.THREADS_DIR, 'broken.md'), '---\nid: broken\n', 'utf8');
  const originalError = console.error;
  const errors: unknown[][] = [];

  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const listed = store.listThreadFiles();

    assert.deepEqual(
      listed.map((item) => item.id),
      [thread.id]
    );
    assert.equal(errors.length, 1);
  } finally {
    console.error = originalError;
  }
});

test('legacy threads expose a default convo synthesized from agents.claude', () => {
  const thread = store.createThread({ title: 'legacy', note: '# legacy\n' });
  store.setThreadAgent(thread.id, 'claude', { session_id: 'legacy-session' });

  const reread = store.getThreadById(thread.id);

  assert.equal(reread?.convos.default?.kind, 'claude');
  assert.equal(reread?.convos.default?.session_id, 'legacy-session');
});

test('setThreadConvo writes a new convo and mirrors default into agents.claude', () => {
  const thread = store.createThread({ title: 'convos', note: '# convos\n' });
  store.setThreadConvo(thread.id, 'default', {
    kind: 'claude',
    session_id: 'default-id',
  });
  store.setThreadConvo(thread.id, 'codex-1', { kind: 'codex', name: 'spike' });

  const reread = store.getThreadById(thread.id);

  assert.equal(reread?.convos.default?.session_id, 'default-id');
  assert.equal(reread?.convos['codex-1']?.kind, 'codex');
  assert.equal(reread?.convos['codex-1']?.name, 'spike');
  assert.equal(reread?.agents.claude?.session_id, 'default-id');
});

test('removeThreadConvo drops a non-default convo and refuses default', () => {
  const thread = store.createThread({ title: 'rm', note: '# rm\n' });
  store.setThreadConvo(thread.id, 'codex-1', { kind: 'codex' });
  store.removeThreadConvo(thread.id, 'codex-1');

  let reread = store.getThreadById(thread.id);
  assert.equal(reread?.convos['codex-1'], undefined);

  store.removeThreadConvo(thread.id, 'default');
  reread = store.getThreadById(thread.id);
  assert.equal(reread?.convos.default?.kind, 'claude');
});

test('setThreadAgent preserves the current note body', () => {
  const thread = store.createThread({
    title: 'agent',
    note: '# agent\n\nkeep me\n',
  });
  store.setThreadAgent(thread.id, 'claude', { session_id: 'session-1' });

  const updated = store.getThreadById(thread.id);

  assert.equal(updated?.note, '# agent\n\nkeep me\n');
  assert.equal(updated?.agents.claude?.session_id, 'session-1');
});
