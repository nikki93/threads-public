import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type * as types from '../_types';
import { readWorkingState } from './working-state.js';

//
// Paths
//

const CLAUDE_PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');

const sessionPathCache = new Map<string, string>();

function sessionPathForCwd(cwd: string, sessionId: string): string {
  return join(CLAUDE_PROJECTS_DIR, cwd.replace(/\//g, '-'), `${sessionId}.jsonl`);
}

function sessionCacheKey(cwd: string, sessionId: string): string {
  return `${cwd}\0${sessionId}`;
}

//
// Parsing
//

function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function contentParts(ev: any): any[] {
  const content = ev?.message?.content;
  return Array.isArray(content) ? content : [];
}

function latestText(events: any[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const ev = events[index];
    if (ev?.type !== 'assistant') continue;
    const text = contentParts(ev).find((part) => part?.type === 'text')?.text;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return undefined;
}

// claude-code injects a synthetic user message like
// "[Request interrupted by user]" or "[Request interrupted by user for tool use]"
// when the user hits Esc to cancel. No hook event fires on cancel (Stop does
// not fire, no dedicated interrupt hook exists as of writing -- see hooks
// docs), so this jsonl marker is the only signal we have. used as a cancel-
// only override on top of the working-state file.
//
// match must be tight: the synthetic interrupt is a free-text user message
// whose content is the marker string itself. tool_result user events may
// legitimately carry that substring (Read of a file containing the text,
// grep output, etc.) and would false-positive a JSON.stringify substring
// scan -- which is exactly how this regressed mid-turn.
function userEventIsInterruptMarker(ev: any): boolean {
  if (ev?.type !== 'user') return false;
  const content = ev?.message?.content;
  if (typeof content === 'string') return content.startsWith('[Request interrupted by user');
  if (!Array.isArray(content)) return false;
  return content.every(
    (part) =>
      part?.type === 'text' &&
      typeof part.text === 'string' &&
      part.text.startsWith('[Request interrupted by user')
  );
}

function latestUserIsInterrupt(events: any[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const ev = events[index];
    if (ev?.type === 'user') return userEventIsInterruptMarker(ev);
    if (ev?.type === 'assistant') return false;
  }
  return false;
}

//
// Public Api
//

export const findClaudeSessionPath: typeof types.findClaudeSessionPath = (args: {
  cwd: string;
  sessionId: string;
}): string | null => {
  const key = sessionCacheKey(args.cwd, args.sessionId);
  const cached = sessionPathCache.get(key);
  if (cached && existsSync(cached)) return cached;
  if (cached) sessionPathCache.delete(key);

  const exact = sessionPathForCwd(args.cwd, args.sessionId);
  if (existsSync(exact)) {
    sessionPathCache.set(key, exact);
    return exact;
  }

  try {
    for (const entry of readdirSync(CLAUDE_PROJECTS_DIR, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(CLAUDE_PROJECTS_DIR, entry.name, `${args.sessionId}.jsonl`);
      if (!existsSync(candidate)) continue;
      sessionPathCache.set(key, candidate);
      return candidate;
    }
  } catch {
    return null;
  }

  return null;
};

export const readClaudeSessionActivity: typeof types.readClaudeSessionActivity = (args: {
  cwd: string;
  sessionId?: string;
  ptyAlive: boolean;
}): { isWorking: boolean; latestBlurb?: string } => {
  if (!args.sessionId) return { isWorking: false };
  // isWorking is driven by the per-session working-state file written by
  // claude code's UserPromptSubmit / Stop hooks (see working-state.ts). The
  // jsonl is used for latestBlurb AND for a cancel-only override -- Stop does
  // not fire when the user hits Esc, so the state file stays "working" until
  // the next prompt. detecting the synthetic "[Request interrupted by user...]"
  // marker at the tail of the jsonl flips us back to idle.
  const working = readWorkingState(args.sessionId);
  let isWorking = args.ptyAlive && working === 'working';
  const path = findClaudeSessionPath({
    cwd: args.cwd,
    sessionId: args.sessionId,
  });
  if (!path) return { isWorking };
  const events = readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(parseJsonLine)
    .filter((ev): ev is any => !!ev && typeof ev === 'object' && 'timestamp' in ev);
  if (isWorking && latestUserIsInterrupt(events)) isWorking = false;
  return {
    isWorking,
    latestBlurb: latestText(events),
  };
};
