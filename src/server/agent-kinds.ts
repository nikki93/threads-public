import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ThreadRecord } from '../_types';
import { findClaudeSessionPath } from './claude-jsonl.js';
import {
  ensureWorkingStateDir,
  initWorkingState,
  workingStateDir,
  workingStatePath,
  workingStateSettingsPath,
} from './working-state.js';

//
// Agent Kinds
//
// Each kind is a CLI agent we host in a PTY. Adding one means: a launcher
// (build the shell command), a session-id discovery story (claude pins it,
// codex assigns one and we read it from the jsonl), and an activity-state
// hook source. Session-id is the key we use for the working-state file.
//

export type AgentKind = 'claude' | 'codex';

export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex'] as const;

export function isAgentKind(value: unknown): value is AgentKind {
  return value === 'claude' || value === 'codex';
}

export function sessionKey(threadId: string, kind: AgentKind): string {
  return `${threadId}:${kind}`;
}

// `/goal <message>` auto_prompts get the goal-restated-each-turn treatment in
// claude's TUI; appending a progress-reporting reminder keeps the sidebar pie
// fed throughout the task without the agent forgetting. applied at delivery
// time (both the spawn-seed and live-PTY paths) so the persisted markdown
// stays whatever the user wrote.
export function decorateGoalAutoPrompt(autoPrompt: string): string {
  if (!autoPrompt.startsWith('/goal ')) return autoPrompt;
  return (
    autoPrompt +
    '\n\n(remember: as you make progress, periodically run' +
    ' `echo N > $THREADS_PROGRESS_FILE` with a rough 0-100 monotonic' +
    ' estimate so the sidebar pie fills. if you abandon or change' +
    ' direction mid-task, clear it yourself: `: > $THREADS_PROGRESS_FILE`)'
  );
}

//
// Launch Inputs
//

export type AgentLaunchMode =
  | { kind: 'resume'; parentSessionId: string }
  | { kind: 'fork'; sessionId: string; parentSessionId: string }
  | { kind: 'fresh'; sessionId?: string };

export interface AgentLaunch {
  command: string;
  // sessionId is known up front for claude (we pin via --session-id), but for
  // codex on fresh launch it's only known after codex writes its first jsonl.
  // when unknown, the supervisor schedules discovery via discoverCodexSessionId.
  sessionId: string | null;
}

//
// Claude Launcher
//

function shellQuote(value: string): string {
  const escaped = value.split("'").join("'\\''");
  return "'" + escaped + "'";
}

export function buildClaudeLaunch(args: {
  thread: ThreadRecord;
  mode: AgentLaunchMode;
  protocolText: string;
  autoPrompt?: string;
}): AgentLaunch {
  const { mode, protocolText, autoPrompt } = args;
  const parts: string[] = ['exec', 'claude'];
  let sessionId: string;
  if (mode.kind === 'resume') {
    sessionId = mode.parentSessionId;
    parts.push('--resume', shellQuote(mode.parentSessionId));
  } else if (mode.kind === 'fork') {
    sessionId = mode.sessionId;
    parts.push(
      '--resume',
      shellQuote(mode.parentSessionId),
      '--fork-session',
      '--session-id',
      shellQuote(mode.sessionId)
    );
  } else {
    sessionId = mode.sessionId ?? randomUUID();
    parts.push('--session-id', shellQuote(sessionId));
  }
  parts.push('--append-system-prompt', shellQuote(protocolText));
  parts.push('--settings', shellQuote(writeClaudeHookSettings(sessionId)));
  if (mode.kind === 'fresh' && autoPrompt) {
    parts.push(shellQuote(decorateGoalAutoPrompt(autoPrompt)));
  }
  return { command: parts.join(' '), sessionId };
}

function writeClaudeHookSettings(sessionId: string): string {
  const statePath = workingStatePath(sessionId);
  const idleHook = {
    hooks: [{ type: 'command', command: `printf idle > ${statePath}` }],
  };
  // UserPromptSubmit also clears the progress file iff its current value is
  // exactly `100` -- preserve mid-task progress so user-steering doesn't
  // reset the pie; only a finished /goal (100) clears. The progress file is
  // keyed by convo (set in the PTY env as THREADS_PROGRESS_FILE) rather
  // than by sessionId, so we read it from the env here.
  const userPromptCmd =
    `printf working > ${statePath}; ` +
    `[ -n "$THREADS_PROGRESS_FILE" ] && ` +
    `[ "$(cat "$THREADS_PROGRESS_FILE" 2>/dev/null)" = "100" ] && ` +
    `: > "$THREADS_PROGRESS_FILE"; :`;
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: userPromptCmd }] }],
      Stop: [idleHook],
      StopFailure: [idleHook],
    },
  };
  const path = workingStateSettingsPath(sessionId);
  ensureWorkingStateDir();
  writeFileSync(path, JSON.stringify(settings), 'utf8');
  return path;
}

//
// Codex Launcher
//
// Codex has no `--session-id` (id is assigned by codex) and no
// `--append-system-prompt`. Fresh launches use the protocol as the initial
// user turn; auto_prompt (when present) is concatenated onto the same seed
// so it lands as part of the same first user turn. Resume uses
// `codex resume <id>`. SessionId discovery runs after spawn -- see
// discoverCodexSessionId.
//

export function buildCodexLaunch(args: {
  thread: ThreadRecord;
  mode: AgentLaunchMode;
  protocolText: string;
  autoPrompt?: string;
}): AgentLaunch {
  const { mode, protocolText, autoPrompt } = args;
  const parts: string[] = [
    'exec',
    'codex',
    '--sandbox',
    'danger-full-access',
    '--ask-for-approval',
    'never',
  ];
  if (mode.kind === 'resume') {
    parts.push('resume', shellQuote(mode.parentSessionId));
    return { command: parts.join(' '), sessionId: mode.parentSessionId };
  }
  const seed = autoPrompt
    ? `${protocolText}\n\n---\n\n${decorateGoalAutoPrompt(autoPrompt)}`
    : protocolText;
  parts.push(shellQuote(seed));
  return { command: parts.join(' '), sessionId: null };
}

//
// Codex Session Discovery
//
// After a fresh codex spawn we don't know the session id. Codex writes
// session jsonl at ~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl.
// Poll the day-shard directory for new files appearing after spawn; first
// line has session_meta.payload.id.
//

const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');

function todayShardDir(): string {
  const now = new Date();
  return join(
    CODEX_SESSIONS_DIR,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  );
}

function readSessionMetaId(filePath: string): string | null {
  try {
    const firstLine = readFileSync(filePath, 'utf8').split('\n', 1)[0];
    if (!firstLine) return null;
    const obj = JSON.parse(firstLine);
    if (obj?.type !== 'session_meta') return null;
    const id = obj?.payload?.id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

// poll for the newest codex session file created after `afterMs` (epoch ms).
// returns the discovered session_id, or null on timeout.
export async function discoverCodexSessionId(args: {
  afterMs: number;
  cwd: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const timeoutMs = args.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dir = todayShardDir();
    if (existsSync(dir)) {
      let best: { path: string; mtime: number; id: string } | null = null;
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith('.jsonl')) continue;
        const full = join(dir, entry);
        let mtime: number;
        try {
          mtime = statSync(full).mtimeMs;
        } catch {
          continue;
        }
        if (mtime < args.afterMs) continue;
        const id = readSessionMetaId(full);
        if (!id) continue;
        // tie-break by matching cwd if recorded in session_meta? for now just
        // use newest matching mtime. multiple concurrent codex spawns in the
        // same second are unlikely; tighten later if it bites.
        if (!best || mtime > best.mtime) best = { path: full, mtime, id };
      }
      if (best) return best.id;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

//
// Existing-Session Probe
//

export function findExistingSession(args: {
  kind: AgentKind;
  workingDirectory: string;
  sessionId: string | undefined;
}): string | null {
  if (!args.sessionId) return null;
  if (args.kind === 'claude') {
    const path = findClaudeSessionPath({
      cwd: args.workingDirectory,
      sessionId: args.sessionId,
    });
    return path ? args.sessionId : null;
  }
  // codex: scan day shards for a file containing this session id. cheap
  // enough since we only do this once per spawn.
  if (!existsSync(CODEX_SESSIONS_DIR)) return null;
  for (const year of readdirSync(CODEX_SESSIONS_DIR)) {
    const yearDir = join(CODEX_SESSIONS_DIR, year);
    if (!existsSync(yearDir)) continue;
    for (const month of readdirSync(yearDir)) {
      const monthDir = join(yearDir, month);
      for (const day of readdirSync(monthDir)) {
        const dayDir = join(monthDir, day);
        for (const file of readdirSync(dayDir)) {
          if (file.includes(args.sessionId)) {
            return args.sessionId;
          }
        }
      }
    }
  }
  return null;
}

//
// Dispatch
//

export function buildAgentLaunch(args: {
  kind: AgentKind;
  thread: ThreadRecord;
  mode: AgentLaunchMode;
  protocolText: string;
  autoPrompt?: string;
}): AgentLaunch {
  if (args.kind === 'claude') return buildClaudeLaunch(args);
  return buildCodexLaunch(args);
}

//
// Codex Hooks Installation
//
// Codex loads hooks from ~/.codex/hooks.json and <walk-up>/.codex/hooks.json.
// We install at <workingDirectory>/.codex/hooks.json so it's scoped to
// the threads repo and doesn't pollute the user's global codex config. Idempotent
// rewrite at supervisor boot keeps the absolute working-state path fresh.
//

export function installCodexHooks(workingDirectory: string): void {
  const codexDir = join(workingDirectory, '.codex');
  mkdirSync(codexDir, { recursive: true });
  const stateDirAbs = resolve(workingStateDir());
  // base: read stdin json, extract session_id, write state file.
  // UserPromptSubmit also clears the progress file iff its current value is
  // exactly `100` -- preserve mid-task progress so user-steering doesn't
  // reset the pie; only a finished /goal (100) clears. The progress path
  // comes from the PTY env (set per-convo by the supervisor) so the hook
  // doesn't need session_id to find it.
  const baseScript = (kind: 'working' | 'idle') =>
    `const fs=require('fs');const path=require('path');const d=JSON.parse(fs.readFileSync(0,'utf8'));fs.writeFileSync(path.join('${stateDirAbs}',d.session_id+'.txt'),'${kind}')`;
  const userPromptScript =
    baseScript('working') +
    `;try{const pp=process.env.THREADS_PROGRESS_FILE;if(pp&&fs.readFileSync(pp,'utf8').trim()==='100')fs.writeFileSync(pp,'')}catch(e){}`;
  const hookCommand = (script: string) => ['node', '-e', `"${script}"`].join(' ');
  const config = {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [{ type: 'command', command: hookCommand(userPromptScript) }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: 'command', command: hookCommand(baseScript('idle')) }],
        },
      ],
    },
  };
  writeFileSync(join(codexDir, 'hooks.json'), JSON.stringify(config, null, 2));
}

//
// SessionId Init For Both Kinds
//

export function initSessionState(sessionId: string): void {
  initWorkingState(sessionId);
}
