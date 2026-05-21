// explicit-reload server runner.
//
// spawns `tsx src/server/index.ts` as a child and watches `server-reload.trigger`.
// any change to the trigger file kills the child with SIGTERM and respawns it.
// edits to src/server/** do NOT restart the server — the only way to apply
// server code changes is `npm run server:reload` (which touches the trigger).
//
// rationale: the api process owns the WebSocket proxy to the PTY supervisor.
// every restart severs live xterm connections. unconditional file-watching is
// thus a footgun while agents are iterating on server code. explicit reload
// gives the user control over when WS connections die.

import { spawn, type ChildProcess } from 'node:child_process';
import { watch } from 'chokidar';
import { join } from 'node:path';

const ENTRY = join(process.cwd(), 'src/server/index.ts');
const TRIGGER = join(process.cwd(), 'server-reload.trigger');
const TSX_BIN = join(process.cwd(), 'node_modules', '.bin', 'tsx');

let child: ChildProcess | null = null;
let reloading = false;

function spawnServer(): void {
  child = spawn(TSX_BIN, [ENTRY], { stdio: 'inherit' });
  console.log(`[server] spawned api child pid ${child.pid}`);
  child.on('exit', (code, signal) => {
    const wasReload = reloading;
    reloading = false;
    child = null;
    if (wasReload) {
      spawnServer();
    } else if (code !== null && code !== 0) {
      process.exit(code);
    } else if (signal && signal !== 'SIGTERM') {
      process.exit(1);
    }
  });
}

function reload(): void {
  if (!child) {
    spawnServer();
    return;
  }
  if (reloading) return;
  reloading = true;
  console.log(`[server] reload triggered — killing api child pid ${child.pid}`);
  child.kill('SIGTERM');
}

function shutdown(signal: NodeJS.Signals): void {
  if (child) child.kill(signal);
  process.exit(0);
}

watch(TRIGGER, { ignoreInitial: true }).on('all', reload);
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

spawnServer();
