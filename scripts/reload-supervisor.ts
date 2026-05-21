// reliable pty supervisor restart.
//
// reads the supervisor pidfile (written by pty-supervisor.ts on boot),
// SIGTERMs it, waits up to 1s for graceful exit, escalates to SIGKILL if
// needed, and prints final state. the api child's `ensurePtySupervisor`
// respawns the supervisor lazily on the next request — there's nothing to
// do here after the kill.
//
// THIS KILLS EVERY LIVE PTY. all agent terminals (including the agent
// running this script if it's hosted in a thread terminal) will die. that
// is irreducible: the supervisor owns every pty master fd.
//
// fallback: if the pidfile doesn't exist (old supervisor not yet
// bootstrapped), pgrep is used instead.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const socketPath =
  process.env.THREADS_PTY_SOCKET ??
  join(tmpdir(), `threads-${process.getuid?.() ?? 'unknown'}`, 'pty-supervisor.sock');
const pidPath = join(dirname(socketPath), 'supervisor.pid');

function pidsFromFile(): number[] {
  if (!existsSync(pidPath)) return [];
  const value = Number(readFileSync(pidPath, 'utf8').trim());
  return Number.isFinite(value) && value > 0 ? [value] : [];
}

function pidsFromPgrep(): number[] {
  try {
    const out = execSync('pgrep -f "tsx src/server/pty-supervisor.ts"', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return out
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const pids = pidsFromFile().length > 0 ? pidsFromFile() : pidsFromPgrep();
  if (pids.length === 0) {
    console.log(
      '[supervisor:reload] no running supervisor found — will spawn fresh on next api request'
    );
    return;
  }

  console.log(
    `[supervisor:reload] WARNING — killing supervisor pid(s) ${pids.join(', ')}. this terminates ALL live agent ptys.`
  );

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* may have died already */
    }
  }

  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && pids.some(isAlive)) {
    await sleep(50);
  }

  const stubborn = pids.filter(isAlive);
  if (stubborn.length > 0) {
    console.log(`[supervisor:reload] SIGTERM didn't take — SIGKILL on ${stubborn.join(', ')}`);
    for (const pid of stubborn) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* dying */
      }
    }
    await sleep(300);
  }

  const final = pids.filter(isAlive);
  if (final.length > 0) {
    console.log(`[supervisor:reload] FAILED — pid(s) still alive: ${final.join(', ')}`);
    process.exit(1);
  }
  console.log('[supervisor:reload] killed — api will respawn supervisor on next request');
}

void main();
