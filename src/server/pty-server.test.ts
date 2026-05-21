import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

//
// Isolated Module
//

const tempRoot = mkdtempSync(join(tmpdir(), 'pty-server-'));
const socketPath = join(tempRoot, 'pty-supervisor.sock');
process.env.THREADS_PTY_SOCKET = socketPath;

let ptyServer = null as unknown as typeof import('./pty-server');

test.before(async () => {
  ptyServer = await import('./pty-server');
});

test.after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

//
// Tests
//

test('liveThreadIds is a non-starting status query', async () => {
  const ids = await ptyServer.liveThreadIds();

  assert.equal(ids.size, 0);
  assert.equal(existsSync(socketPath), false);
});
