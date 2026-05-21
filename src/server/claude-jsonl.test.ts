import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

//
// Isolated Module
//

const tempRoot = mkdtempSync(join(tmpdir(), 'claude-jsonl-'));
const projectsDir = join(tempRoot, 'projects');
process.env.CLAUDE_PROJECTS_DIR = projectsDir;

let claude = null as unknown as typeof import('./claude-jsonl');

test.before(async () => {
  claude = await import('./claude-jsonl');
});

test.after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

//
// Fixtures
//

function writeSession(projectName: string, sessionId: string, lines: unknown[]): string {
  const dir = join(projectsDir, projectName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  return path;
}

//
// Tests
//

test('findClaudeSessionPath scans by session id when cwd-derived path is wrong', () => {
  const path = writeSession('-real-cwd', 'session-1', []);

  assert.equal(claude.findClaudeSessionPath({ cwd: '/wrong/cwd', sessionId: 'session-1' }), path);
});

test('readClaudeSessionActivity reads fallback session paths', () => {
  writeSession('-actual-cwd', 'session-2', [
    {
      type: 'assistant',
      timestamp: '2026-05-12T12:00:00.000Z',
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done from fallback' }],
      },
    },
  ]);

  const activity = claude.readClaudeSessionActivity({
    cwd: '/not/the/spawn/cwd',
    sessionId: 'session-2',
    ptyAlive: true,
  });

  assert.equal(activity.isWorking, false);
  assert.equal(activity.latestBlurb, 'done from fallback');
});
