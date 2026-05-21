import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

//
// Working-State Files
//
// Per-claude-session "is the agent working?" signal driven by claude code
// lifecycle hooks. The supervisor writes a small settings.json with
// UserPromptSubmit / Stop hooks at spawn time; those hooks `printf working` or
// `printf idle` into a per-session state file. The api reads that file to
// drive the sidebar isWorking indicator -- ground truth from claude code,
// replacing the older jsonl-tail heuristic that got stuck on cancels and slash
// commands.
//
// Path layout (shared between supervisor and api so both compute it
// independently from THREADS_PTY_SOCKET):
//
//   <socket-dir>/working-state/<sessionId>.txt
//   <socket-dir>/working-state/<sessionId>.settings.json
//   <socket-dir>/working-state/<threadId>__<convoId>.progress
//
// State + settings are keyed by sessionId; progress is keyed by the
// thread+convo pair so it's available before sessionId is known (codex
// fresh launches don't have a session id until post-spawn discovery).
//

function socketParentDir(): string {
  const socketPath =
    process.env.THREADS_PTY_SOCKET ??
    join(tmpdir(), `threads-${process.getuid?.() ?? 'unknown'}`, 'pty-supervisor.sock');
  return dirname(socketPath);
}

export function workingStateDir(): string {
  return join(socketParentDir(), 'working-state');
}

export function workingStatePath(sessionId: string): string {
  return join(workingStateDir(), `${sessionId}.txt`);
}

export function workingStateSettingsPath(sessionId: string): string {
  return join(workingStateDir(), `${sessionId}.settings.json`);
}

export function workingStateProgressPath(threadId: string, convoId: string): string {
  return join(workingStateDir(), `${threadId}__${convoId}.progress`);
}

export function ensureWorkingStateDir(): void {
  mkdirSync(workingStateDir(), { recursive: true });
}

//
// Hook Settings
//
// Three hooks cover everything claude code signals as a turn boundary:
// - UserPromptSubmit: flip to working when the user (or auto-prompt) submits
//   a prompt. fires once per turn at turn start.
// - Stop: flip to idle when claude finishes responding normally. fires once
//   per turn at turn end.
// - StopFailure: flip to idle when the turn ends due to an API error
//   (rate_limit, authentication_failed, server_error, max_output_tokens,
//   etc.). without this, an API-errored turn leaves the indicator stuck on.
//
// The hook command is a hard-coded `printf` to the per-session state file
// path (no spaces in the path, plain ascii) so shell quoting is trivial.
//
// Not bound and why:
// - cancel (Esc): claude code fires NO hook on user-interrupt -- not Stop,
//   not StopFailure, not Notification. handled separately by claude-jsonl.ts
//   detecting the synthetic "[Request interrupted by user...]" user message
//   in the jsonl as a cancel-only override on top of this signal.
// - SubagentStop: fires when a subagent finishes; the main turn is still
//   running, so binding it would clear the indicator mid-turn.
// - Notification (permission_prompt etc.): the agent is paused waiting for
//   user input but still inside the turn. flipping to idle would flicker the
//   indicator on every permission prompt during a long turn.
// - SessionEnd: pty.onExit in the supervisor already calls clearWorkingState
//   when claude exits, so this is redundant.
//

export function writeHookSettings(sessionId: string): string {
  ensureWorkingStateDir();
  const statePath = workingStatePath(sessionId);
  const idleHook = {
    hooks: [{ type: 'command', command: `printf idle > ${statePath}` }],
  };
  // UserPromptSubmit also clears the progress file iff its current value is
  // exactly `100` -- so a fresh user turn after a finished /goal resets the
  // pie, but mid-task user steering (any non-100 value) preserves progress.
  // Progress path comes from the PTY env so we don't need the convo key here.
  const userPromptCmd =
    `printf working > ${statePath}; ` +
    `[ -n "$THREADS_PROGRESS_FILE" ] && ` +
    `[ "$(cat "$THREADS_PROGRESS_FILE" 2>/dev/null)" = "100" ] && ` +
    `: > "$THREADS_PROGRESS_FILE"; :`;
  const settings = {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [{ type: 'command', command: userPromptCmd }],
        },
      ],
      Stop: [idleHook],
      StopFailure: [idleHook],
    },
  };
  const path = workingStateSettingsPath(sessionId);
  writeFileSync(path, JSON.stringify(settings), 'utf8');
  return path;
}

export function initWorkingState(sessionId: string): void {
  ensureWorkingStateDir();
  // overwrite any leftover state from a prior session under the same id so
  // resume doesn't show stale "working" before the first hook fires.
  writeFileSync(workingStatePath(sessionId), 'idle', 'utf8');
}

export function clearWorkingState(args: {
  sessionId?: string;
  threadId: string;
  convoId: string;
}): void {
  const paths: string[] = [workingStateProgressPath(args.threadId, args.convoId)];
  if (args.sessionId) {
    paths.push(workingStatePath(args.sessionId));
    paths.push(workingStateSettingsPath(args.sessionId));
  }
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch {
      /* best-effort cleanup */
    }
  }
}

export function readWorkingState(sessionId: string): 'working' | 'idle' | null {
  try {
    const content = readFileSync(workingStatePath(sessionId), 'utf8').trim();
    return content === 'working' ? 'working' : 'idle';
  } catch {
    return null;
  }
}

export function readWorkingStateProgress(threadId: string, convoId: string): number {
  try {
    const content = readFileSync(workingStateProgressPath(threadId, convoId), 'utf8').trim();
    const n = Number.parseInt(content, 10);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  } catch {
    return 0;
  }
}
