import type * as types from './_types';

//
// Constants
//

const SOURCE = 'threads';
const ENDPOINT = '/api/activity';
const FLUSH_DELAY_MS = 500;
const FLUSH_THRESHOLD = 32;

//
// Identity
//

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return Math.random().toString(36).slice(2, 14);
}

const tabOpenId = makeId();
const queue: Array<Record<string, unknown>> = [];
let flushTimer: number | null = null;
let flushing = false;

//
// Flush
//

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DELAY_MS);
}

async function flush(): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue.splice(0, queue.length);
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    });
  } catch {
    // Activity logging is best-effort debug context.
  } finally {
    flushing = false;
  }
}

function flushSync(): void {
  if (queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  const body = JSON.stringify({ events: batch });
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    });
  } catch {
    /* ignore */
  }
}

//
// Public Api
//

export const logActivity: typeof types.logActivity = (
  event: string,
  extra: Record<string, unknown> = {}
): void => {
  queue.push({
    source: SOURCE,
    tabOpenId,
    event,
    clientTs: new Date().toISOString(),
    pageMs: Math.round(performance.now()),
    ...extra,
  });
  if (queue.length >= FLUSH_THRESHOLD) {
    if (flushTimer !== null) window.clearTimeout(flushTimer);
    flushTimer = null;
    void flush();
  } else {
    scheduleFlush();
  }
};

export const getTabOpenId: typeof types.getTabOpenId = (): string => tabOpenId;

//
// Page Lifecycle
//

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushSync);
  window.addEventListener('beforeunload', flushSync);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSync();
  });
}
