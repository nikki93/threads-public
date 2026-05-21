import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type * as types from './_types';
import type { AppState, ConvoKind, ConvoState, ThreadRecord, ThreadTreeNode } from './_types';
import { logActivity } from './activity';

export const DEFAULT_CONVO_ID = 'default';

export const convoTokenKey = (threadId: string, convoId: string): string =>
  `${threadId}:${convoId}`;

//
// Thread Titles
//

export { cleanThreadTitleLine, deriveThreadTitle } from './thread-title';

//
// Client Api
//

export const apiGet: typeof types.apiGet = async <T>(path: string): Promise<T> => {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
};

export const apiPost: typeof types.apiPost = async <T>(
  path: string,
  body?: unknown
): Promise<T> => {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
};

export const apiPatch: typeof types.apiPatch = async <T>(
  path: string,
  body: unknown
): Promise<T> => {
  const response = await fetch(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
};

export const apiDelete: typeof types.apiDelete = async <T>(path: string): Promise<T> => {
  const response = await fetch(path, { method: 'DELETE' });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
};

//
// Thread Helpers
//

export const selectedThread: typeof types.selectedThread = (state: AppState): ThreadRecord | null =>
  state.threads.find((thread) => thread.id === state.selectedId) ?? null;

export const ancestorChain: typeof types.ancestorChain = (
  threads: ThreadRecord[],
  id: string
): ThreadRecord[] => {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const out: ThreadRecord[] = [];
  let cursor = byId.get(id);
  while (cursor?.parentId) {
    const parent = byId.get(cursor.parentId);
    if (!parent) break;
    out.unshift(parent);
    cursor = parent;
  }
  return out;
};

function compareThreadSlugs(a: string, b: string): number {
  const left = a.split('__');
  const right = b.split('__');
  const count = Math.min(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const cmp = left[index]!.localeCompare(right[index]!);
    if (cmp !== 0) return cmp;
  }
  return left.length - right.length;
}

// sibling ordering: explicit `order` wins (ascending). threads without an
// `order` sort after all explicitly-ordered siblings, with slug compare as
// the stable fallback.
function compareSiblings(a: ThreadRecord, b: ThreadRecord): number {
  const ao = typeof a.order === 'number' ? a.order : Infinity;
  const bo = typeof b.order === 'number' ? b.order : Infinity;
  if (ao !== bo) return ao - bo;
  return compareThreadSlugs(a.slug, b.slug);
}

export const orderedThreads: typeof types.orderedThreads = (
  threads: ThreadRecord[]
): ThreadRecord[] => [...threads].sort((a, b) => compareThreadSlugs(a.slug, b.slug));

function makeThreadTreeNodes(threads: ThreadRecord[]): Map<string, ThreadTreeNode> {
  const nodes = new Map<string, ThreadTreeNode>();
  for (const thread of orderedThreads(threads)) {
    nodes.set(thread.id, { thread, children: [] });
  }
  return nodes;
}

function appendThreadTreeNode(
  node: ThreadTreeNode,
  nodes: Map<string, ThreadTreeNode>,
  roots: ThreadTreeNode[]
): void {
  const parent = node.thread.parentId ? nodes.get(node.thread.parentId) : null;
  if (parent) parent.children.push(node);
  else roots.push(node);
}

function sortTreeChildren(node: ThreadTreeNode): void {
  node.children.sort((a, b) => compareSiblings(a.thread, b.thread));
  for (const child of node.children) sortTreeChildren(child);
}

export const buildThreadTree: typeof types.buildThreadTree = (
  threads: ThreadRecord[]
): ThreadTreeNode[] => {
  const nodes = makeThreadTreeNodes(threads);
  const roots: ThreadTreeNode[] = [];
  for (const node of nodes.values()) appendThreadTreeNode(node, nodes, roots);
  roots.sort((a, b) => compareSiblings(a.thread, b.thread));
  for (const root of roots) sortTreeChildren(root);
  return roots;
};

export const visibleThreadsForSidebar: typeof types.visibleThreadsForSidebar = (
  nodes: ThreadTreeNode[],
  collapsed: Record<string, boolean>,
  showArchived: boolean
): ThreadRecord[] => {
  const out: ThreadRecord[] = [];
  const visit = (node: ThreadTreeNode): void => {
    if (node.thread.archived && !showArchived) return;
    out.push(node.thread);
    if (collapsed[node.thread.id]) return;
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
};

// flat list of sidebar items in display order. each item is either a thread
// row (thread itself, representing its default convo) or a convo row (a
// non-default convo of its thread). this is what arrow-key nav iterates.
// archived convos are filtered out by default -- they stay in frontmatter for
// recovery but shouldn't clutter the active list. pass showArchived=true to
// include them (mirrors the show-archived treatment of archived threads).
export function nonDefaultConvoIds(thread: ThreadRecord, showArchived = false): string[] {
  return Object.keys(thread.convos).filter(
    (id) => id !== DEFAULT_CONVO_ID && (showArchived || !thread.convos[id]?.archived)
  );
}

export const visibleSidebarItems: typeof types.visibleSidebarItems = (
  nodes: ThreadTreeNode[],
  collapsed: Record<string, boolean>,
  showArchived: boolean
) => {
  const out: types.SidebarItem[] = [];
  const visit = (node: ThreadTreeNode): void => {
    if (node.thread.archived && !showArchived) return;
    out.push({ kind: 'thread', threadId: node.thread.id });
    if (collapsed[node.thread.id]) return;
    for (const convoId of nonDefaultConvoIds(node.thread, showArchived)) {
      out.push({ kind: 'convo', threadId: node.thread.id, convoId });
    }
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
};

// auto-collapse mode: a thread stays expanded only if it is the selected
// thread or one of its ancestors. the selected thread's own children show
// as collapsed rows; every other tree collapses. returns a collapsed map
// (true = collapsed).
export const derivedCollapsedForSelection: typeof types.derivedCollapsedForSelection = (
  nodes: ThreadTreeNode[],
  selectedThreadId: string | null
): Record<string, boolean> => {
  const all: string[] = [];
  const collect = (node: ThreadTreeNode): void => {
    all.push(node.thread.id);
    for (const child of node.children) collect(child);
  };
  for (const node of nodes) collect(node);

  const expanded = new Set<string>();
  const walk = (node: ThreadTreeNode, ancestors: string[]): boolean => {
    if (node.thread.id === selectedThreadId) {
      for (const ancestor of ancestors) expanded.add(ancestor);
      expanded.add(node.thread.id);
      return true;
    }
    for (const child of node.children) {
      if (walk(child, [...ancestors, node.thread.id])) return true;
    }
    return false;
  };
  if (selectedThreadId) {
    for (const node of nodes) {
      if (walk(node, [])) break;
    }
  }

  const out: Record<string, boolean> = {};
  for (const id of all) if (!expanded.has(id)) out[id] = true;
  return out;
};

// the collapsed map to feed sidebar-visibility utils: the selection-derived
// map when auto-collapse mode is on, else the manual collapsed map.
export const effectiveCollapsedMap: typeof types.effectiveCollapsedMap = (
  state: AppState
): Record<string, boolean> => {
  if (!state.autoCollapseToSelection) return state.collapsedThreadIds;
  return derivedCollapsedForSelection(buildThreadTree(state.threads), state.selectedId);
};

// resolve the currently-selected sidebar item from state. matches what
// arrow-key nav and the sidebar render treat as "selected": the thread row
// when active convo is default (or unset), the convo row otherwise.
export const currentSidebarItem: typeof types.currentSidebarItem = (
  state: AppState
): types.SidebarItem | null => {
  if (!state.selectedId) return null;
  const activeConvo = state.activeConvoByThread[state.selectedId];
  if (!activeConvo || activeConvo === DEFAULT_CONVO_ID) {
    return { kind: 'thread', threadId: state.selectedId };
  }
  return { kind: 'convo', threadId: state.selectedId, convoId: activeConvo };
};

export const selectSidebarItem: typeof types.selectSidebarItem = (
  item: types.SidebarItem
): void => {
  // set the active convo BEFORE selectThread so the needs-review arm in
  // applySelectThread reads the correct (thread, convo) pair.
  if (item.kind === 'convo' && item.convoId) {
    setActiveConvo(item.threadId, item.convoId);
  } else {
    // thread row selection means "back to the default convo". keep this
    // explicit so arrow-up from a convo row lands on the thread, not on the
    // last-active non-default convo.
    setActiveConvo(item.threadId, DEFAULT_CONVO_ID);
  }
  // route through selectThread so history / focus / needs-review state stay
  // consistent with thread-only nav.
  selectThread(item.threadId);
  // mobile: any sidebar row tap (thread or convo) jumps to the convo
  // terminal tab so the user lands on the agent prompt directly. desktop
  // ignores `mobilePane` since the layout is fixed -- setting it
  // unconditionally is harmless and persists the last choice.
  setMobilePane('terminal');
  if (isMobileViewport()) {
    setFocusedPane('terminal');
    window.setTimeout(() => window.dispatchEvent(new Event('threads-terminal-focus')), 0);
  }
};

function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
}

function applySelection(thread: ThreadRecord | null): Partial<AppState> {
  if (!thread) {
    return {
      selectedId: null,
      noteDraft: '',
      noteDraftThreadId: null,
      noteDraftBaseline: '',
      noteSaveError: null,
    };
  }
  return {
    selectedId: thread.id,
    noteDraft: thread.note,
    noteDraftThreadId: thread.id,
    noteDraftBaseline: thread.note,
    noteSaveError: null,
  };
}

function threadPreviewConfigKey(thread: ThreadRecord): string {
  const preview = thread.preview;
  if (!preview) return '';
  return JSON.stringify({
    command: preview.command ?? '',
    cwd: preview.cwd ?? (preview as { workingDirectory?: string }).workingDirectory ?? '',
    label: preview.label ?? '',
    port: preview.port ?? null,
    url: preview.url ?? '',
  });
}

function reconciledPreviewCache(
  threads: ThreadRecord[],
  state: AppState
): Pick<AppState, 'previewUrls' | 'previewLabels' | 'previewConfigKeys'> {
  const ids = new Set(threads.map((thread) => thread.id));
  const urls: Record<string, string> = {};
  const labels: Record<string, string> = {};
  const keys: Record<string, string> = {};

  for (const thread of threads) {
    const key = threadPreviewConfigKey(thread);
    if (!key) continue;
    keys[thread.id] = key;
    if (state.previewConfigKeys[thread.id] !== key) continue;
    if (state.previewUrls[thread.id]) urls[thread.id] = state.previewUrls[thread.id]!;
    if (state.previewLabels[thread.id]) labels[thread.id] = state.previewLabels[thread.id]!;
  }

  for (const id of Object.keys(state.previewUrls)) {
    if (ids.has(id)) continue;
    delete urls[id];
    delete labels[id];
    delete keys[id];
  }

  return { previewUrls: urls, previewLabels: labels, previewConfigKeys: keys };
}

//
// Store Actions
//

// preview visibility is a derived value (selectedThread.previewOpen). this
// map lets in-flight patches resist clobber when SSE refetches arrive before
// the previewOpen patch has landed on disk.
const pendingPreviewOpenPatch = new Map<string, boolean>();

function mergeThreadsWithPending(threads: ThreadRecord[]): ThreadRecord[] {
  if (pendingPreviewOpenPatch.size === 0) return threads;
  return threads.map((thread) =>
    pendingPreviewOpenPatch.has(thread.id)
      ? { ...thread, previewOpen: pendingPreviewOpenPatch.get(thread.id)! }
      : thread
  );
}

// per-convo previous isWorking value, used to detect the working→idle
// transition that arms the needs-review indicator. module-level (not in
// zustand state) since it's just plumbing for diffing successive
// /api/threads payloads. keyed by `${threadId}:${convoId}` so every convo
// (default and non-default) gets its own transition signal.
const prevWorkingMap = new Map<string, boolean>();

export const needsReviewKey = (threadId: string, convoId: string): string =>
  `${threadId}:${convoId}`;

// timer that clears the needs-review indicator after the user has stayed on
// the selected (thread, convo) for 1.2s. cancelled on any selectSidebarItem
// change so fast alt+up/down scroll-through doesn't accidentally clear an
// unread indicator.
let needsReviewClearTimer: number | null = null;

function cancelNeedsReviewClear(): void {
  if (needsReviewClearTimer !== null) {
    window.clearTimeout(needsReviewClearTimer);
    needsReviewClearTimer = null;
  }
}

function armNeedsReviewClear(key: string): void {
  needsReviewClearTimer = window.setTimeout(() => {
    needsReviewClearTimer = null;
    useAppStore.setState((state) => {
      if (!state.needsReviewIds[key]) return {};
      const next = { ...state.needsReviewIds };
      delete next[key];
      return { needsReviewIds: next };
    });
  }, 1200);
}

function activeConvoForReview(state: AppState, threadId: string): string {
  return state.activeConvoByThread[threadId] ?? DEFAULT_CONVO_ID;
}

function computeNextNeedsReview(threads: ThreadRecord[], state: AppState): Record<string, boolean> {
  const next = { ...state.needsReviewIds };
  const liveKeys = new Set<string>();
  for (const thread of threads) {
    const activeConvo = activeConvoForReview(state, thread.id);
    for (const [convoId, convo] of Object.entries(thread.convos)) {
      const key = needsReviewKey(thread.id, convoId);
      liveKeys.add(key);
      const prev = prevWorkingMap.get(key) ?? false;
      const curr = !!convo.isWorking;
      const selectedHere = state.selectedId === thread.id && activeConvo === convoId;
      if (prev && !curr && !selectedHere) next[key] = true;
      prevWorkingMap.set(key, curr);
    }
  }
  for (const key of Object.keys(next)) {
    if (!liveKeys.has(key)) delete next[key];
  }
  for (const key of [...prevWorkingMap.keys()]) {
    if (!liveKeys.has(key)) prevWorkingMap.delete(key);
  }
  return next;
}

// when the selected thread stops being visible in the sidebar -- archived
// directly, or hidden via an archived ancestor in the cascade -- pick the
// next surviving visible thread anchored on the prior position. next sibling
// in the visible order, falling back to previous, then to none. anchored on
// the previous visible list so cascade hides keep a stable reference.
function pickNextVisibleSelection(
  prevState: AppState,
  nextThreads: ThreadRecord[]
): { needsReselect: boolean; nextId: string | null } {
  const selectedId = prevState.selectedId;
  if (!selectedId) return { needsReselect: false, nextId: null };
  const collapsed = effectiveCollapsedMap(prevState);
  const nextVisible = visibleThreadsForSidebar(
    buildThreadTree(nextThreads),
    collapsed,
    prevState.showArchived
  );
  const nextVisibleIds = new Set(nextVisible.map((thread) => thread.id));
  if (nextVisibleIds.has(selectedId)) return { needsReselect: false, nextId: null };
  const prevVisible = visibleThreadsForSidebar(
    buildThreadTree(prevState.threads),
    collapsed,
    prevState.showArchived
  );
  const anchor = prevVisible.findIndex((thread) => thread.id === selectedId);
  if (anchor === -1) {
    return { needsReselect: true, nextId: nextVisible[0]?.id ?? null };
  }
  for (let i = anchor + 1; i < prevVisible.length; i += 1) {
    if (nextVisibleIds.has(prevVisible[i]!.id)) {
      return { needsReselect: true, nextId: prevVisible[i]!.id };
    }
  }
  for (let i = anchor - 1; i >= 0; i -= 1) {
    if (nextVisibleIds.has(prevVisible[i]!.id)) {
      return { needsReselect: true, nextId: prevVisible[i]!.id };
    }
  }
  return { needsReselect: true, nextId: null };
}

// closest non-archived convo sibling of `anchorConvoId` within `thread`,
// scanning forward then backward through the frontmatter convo order.
// the anchor itself is treated as "going away" (already archived in the
// agent path, about to be archived in the manual path), so it's never
// returned even if its current archived flag is false.
function pickNextNonArchivedConvo(thread: ThreadRecord, anchorConvoId: string): string | null {
  const ids = Object.keys(thread.convos).filter((id) => id !== DEFAULT_CONVO_ID);
  const anchor = ids.indexOf(anchorConvoId);
  if (anchor === -1) return null;
  const isVisible = (id: string): boolean => {
    if (id === anchorConvoId) return false;
    const convo = thread.convos[id];
    return !!convo && !convo.archived;
  };
  for (let i = anchor + 1; i < ids.length; i += 1) if (isVisible(ids[i]!)) return ids[i]!;
  for (let i = anchor - 1; i >= 0; i -= 1) if (isVisible(ids[i]!)) return ids[i]!;
  return null;
}

// when the focused convo on the still-visible selected thread becomes
// archived in the new state (frontmatter flip via file edit), shift
// activeConvoByThread to the closest non-archived convo sibling so focus
// stays on a convo row. fall back to deleting the entry (thread row /
// default convo) only when no sibling remains. archived convos are
// always hidden from the sidebar regardless of showArchived, so no
// showArchived gate here.
function shiftedActiveConvoForThread(
  activeConvoByThread: Record<string, string>,
  thread: ThreadRecord
): Record<string, string> {
  const activeConvo = activeConvoByThread[thread.id];
  if (!activeConvo || activeConvo === DEFAULT_CONVO_ID) return activeConvoByThread;
  const convo = thread.convos[activeConvo];
  if (convo && !convo.archived) return activeConvoByThread;
  const next = { ...activeConvoByThread };
  const sibling = pickNextNonArchivedConvo(thread, activeConvo);
  if (sibling) next[thread.id] = sibling;
  else delete next[thread.id];
  return next;
}

export const loadThreads: typeof types.loadThreads = async (): Promise<void> => {
  useAppStore.setState({ loading: true, error: null });
  try {
    const fetched = orderedThreads(await apiGet<ThreadRecord[]>('/api/threads'));
    const threads = mergeThreadsWithPending(fetched);
    const state = useAppStore.getState();
    const previewCache = reconciledPreviewCache(threads, state);
    const needsReviewIds = computeNextNeedsReview(threads, state);
    const current = threads.find((thread) => thread.id === state.selectedId);
    if (current) {
      // cascade-archive case: selected thread still exists in the data but
      // is now hidden because an ancestor became archived. fall through to
      // the reselect path.
      const visibleIds = new Set(
        visibleThreadsForSidebar(
          buildThreadTree(threads),
          effectiveCollapsedMap(state),
          state.showArchived
        ).map((thread) => thread.id)
      );
      if (!visibleIds.has(current.id)) {
        const reselect = pickNextVisibleSelection(state, threads);
        useAppStore.setState({
          threads,
          loading: false,
          ...previewCache,
          needsReviewIds,
        });
        if (reselect.nextId) selectThread(reselect.nextId);
        else useAppStore.setState({ ...applySelection(null) });
        return;
      }
      const nextActiveConvoByThread = shiftedActiveConvoForThread(
        state.activeConvoByThread,
        current
      );
      const activeConvoPatch =
        nextActiveConvoByThread === state.activeConvoByThread
          ? {}
          : { activeConvoByThread: nextActiveConvoByThread };
      if (state.noteDraftThreadId === current.id) {
        const hasUnsavedEdits = state.noteDraft !== state.noteDraftBaseline;
        if (hasUnsavedEdits) {
          useAppStore.setState({
            threads,
            loading: false,
            ...previewCache,
            needsReviewIds,
            ...activeConvoPatch,
          });
        } else {
          useAppStore.setState({
            threads,
            loading: false,
            ...previewCache,
            needsReviewIds,
            noteDraft: current.note,
            noteDraftBaseline: current.note,
            ...activeConvoPatch,
          });
        }
      } else {
        useAppStore.setState({
          threads,
          loading: false,
          ...previewCache,
          needsReviewIds,
          noteDraft: current.note,
          noteDraftThreadId: current.id,
          noteDraftBaseline: current.note,
          ...activeConvoPatch,
        });
      }
      return;
    }
    const firstActive = threads.find((thread) => !thread.archived) ?? threads[0] ?? null;
    useAppStore.setState({
      threads,
      loading: false,
      ...previewCache,
      needsReviewIds,
      ...applySelection(firstActive),
    });
  } catch (error) {
    useAppStore.setState({ loading: false, error: String(error) });
    logActivity('load_error', { message: String(error) });
  }
};

export const threadHasPreviewConfig: typeof types.threadHasPreviewConfig = (
  thread: ThreadRecord | null | undefined
): boolean => {
  if (!thread?.preview) return false;
  if (thread.preview.url) return true;
  return !!thread.preview.command && typeof thread.preview.port === 'number';
};

const SELECTED_HISTORY_CAP = 50;
const SELECTED_HISTORY_DWELL_MS = 800;

// history pushes are dwell-filtered so spamming alt+up/down doesn't fill
// history with intermediate threads. selectThread schedules the push;
// another selectThread or any navigateThreadHistory cancels it.
let pendingHistoryPushTimer: number | null = null;

function cancelPendingHistoryPush(): void {
  if (pendingHistoryPushTimer !== null) {
    window.clearTimeout(pendingHistoryPushTimer);
    pendingHistoryPushTimer = null;
  }
}

function schedulePendingHistoryPush(id: string): void {
  cancelPendingHistoryPush();
  pendingHistoryPushTimer = window.setTimeout(() => {
    pendingHistoryPushTimer = null;
    const state = useAppStore.getState();
    if (state.selectedId !== id) return;
    useAppStore.setState(pushSelectedHistory(state, id));
  }, SELECTED_HISTORY_DWELL_MS);
}

// shared selection mutation. selectThread defers the history push via the
// dwell timer; navigateThreadHistory moves the cursor directly so back/forward
// doesn't pollute history with its own entries.
function applySelectThread(id: string, historyPatch?: Partial<AppState>): void {
  cancelNeedsReviewClear();
  const state = useAppStore.getState();
  const thread = state.threads.find((item) => item.id === id) ?? null;
  void saveSelectedThread();
  useAppStore.setState({
    ...applySelection(thread),
    terminalError: null,
    ...(historyPatch ?? {}),
  });
  logActivity('thread_select', { threadId: id });
  const activeConvo = activeConvoForReview(useAppStore.getState(), id);
  const reviewKey = needsReviewKey(id, activeConvo);
  if (state.needsReviewIds[reviewKey]) armNeedsReviewClear(reviewKey);
  // if the user was last in the terminal, follow them across nav. when the
  // new thread has no TerminalView mounted (no token), nothing listens and the
  // preference simply persists for the next selection that does have one.
  if (useAppStore.getState().focusedPane === 'terminal') {
    window.setTimeout(() => window.dispatchEvent(new Event('threads-terminal-focus')), 0);
  }
}

function pushSelectedHistory(state: AppState, id: string): Partial<AppState> {
  // drop forward entries past the cursor, append, cap at the head.
  const truncated = state.selectedHistory.slice(0, state.selectedHistoryIndex + 1);
  if (truncated[truncated.length - 1] === id) {
    return {
      selectedHistory: truncated,
      selectedHistoryIndex: truncated.length - 1,
    };
  }
  truncated.push(id);
  const overflow = Math.max(0, truncated.length - SELECTED_HISTORY_CAP);
  const trimmed = overflow > 0 ? truncated.slice(overflow) : truncated;
  return { selectedHistory: trimmed, selectedHistoryIndex: trimmed.length - 1 };
}

export const selectThread: typeof types.selectThread = (id: string): void => {
  applySelectThread(id);
  schedulePendingHistoryPush(id);
};

export const navigateThreadHistory: typeof types.navigateThreadHistory = (
  direction: -1 | 1
): boolean => {
  cancelPendingHistoryPush();
  const state = useAppStore.getState();
  // in auto-collapse mode history nav walks every thread (full tree) so
  // entries in collapsed subtrees aren't pruned out of history.
  const collapsedForNav = state.autoCollapseToSelection ? {} : state.collapsedThreadIds;
  const visibleIds = new Set(
    visibleThreadsForSidebar(
      buildThreadTree(state.threads),
      collapsedForNav,
      state.showArchived
    ).map((thread) => thread.id)
  );
  const history = [...state.selectedHistory];
  let currentIndex = state.selectedHistoryIndex;

  if (direction === 1) {
    let probe = currentIndex + 1;
    while (probe < history.length && !visibleIds.has(history[probe]!)) {
      history.splice(probe, 1);
      // probe stays put -- the next entry slid down into this index.
    }
    if (probe >= history.length) {
      useAppStore.setState({
        selectedHistory: history,
        selectedHistoryIndex: currentIndex,
      });
      return false;
    }
    applySelectThread(history[probe]!, {
      selectedHistory: history,
      selectedHistoryIndex: probe,
    });
    return true;
  }

  let probe = currentIndex - 1;
  while (probe >= 0 && !visibleIds.has(history[probe]!)) {
    history.splice(probe, 1);
    currentIndex -= 1;
    probe -= 1;
  }
  if (probe < 0) {
    useAppStore.setState({
      selectedHistory: history,
      selectedHistoryIndex: currentIndex,
    });
    return false;
  }
  applySelectThread(history[probe]!, {
    selectedHistory: history,
    selectedHistoryIndex: probe,
  });
  return true;
};

export const setFocusedPane: typeof types.setFocusedPane = (pane): void => {
  if (useAppStore.getState().focusedPane === pane) return;
  useAppStore.setState({ focusedPane: pane });
};

export const setMobilePane: typeof types.setMobilePane = (pane): void => {
  if (useAppStore.getState().mobilePane === pane) return;
  useAppStore.setState({ mobilePane: pane });
};

export const toggleAncestor: typeof types.toggleAncestor = (): void => {
  useAppStore.setState((state) => ({ ancestorOpen: !state.ancestorOpen }));
};

export const toggleThreadCollapsed: typeof types.toggleThreadCollapsed = (id: string): void => {
  useAppStore.setState((state) => ({
    collapsedThreadIds: {
      ...state.collapsedThreadIds,
      [id]: !state.collapsedThreadIds[id],
    },
  }));
  logActivity('thread_collapse_toggle', { threadId: id });
};

export const toggleShowArchived: typeof types.toggleShowArchived = (): void => {
  const next = !useAppStore.getState().showArchived;
  useAppStore.setState({ showArchived: next });
  logActivity('show_archived_toggle', { showArchived: next });
};

export const toggleAutoCollapseToSelection: typeof types.toggleAutoCollapseToSelection =
  (): void => {
    const next = !useAppStore.getState().autoCollapseToSelection;
    useAppStore.setState({ autoCollapseToSelection: next });
    logActivity('auto_collapse_toggle', { autoCollapseToSelection: next });
  };

// labels we match against for a convo row: name if present, else convoId.
// (the default convo's label uses kind, but we don't list default in the
// sidebar's flat convo rows so it's not in the search corpus.)
function convoSearchLabel(convoId: string, convo: ConvoState): string {
  return convo.name || convoId;
}

export function matchingConvoIds(thread: ThreadRecord, query: string): string[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];
  const out: string[] = [];
  for (const convoId of nonDefaultConvoIds(thread)) {
    const convo = thread.convos[convoId];
    if (!convo) continue;
    if (convoSearchLabel(convoId, convo).toLowerCase().includes(trimmed)) out.push(convoId);
  }
  return out;
}

// keep only nodes that match the query in their title, have a matching
// convo, or have a descendant that does. preserves the tree shape so the
// user sees the path to each match. case-insensitive substring.
export function pruneTreeByQuery(nodes: ThreadTreeNode[], query: string): ThreadTreeNode[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return nodes;
  const out: ThreadTreeNode[] = [];
  for (const node of nodes) {
    const childMatches = pruneTreeByQuery(node.children, query);
    const selfMatches = node.thread.title.toLowerCase().includes(trimmed);
    const convoMatches = matchingConvoIds(node.thread, query).length > 0;
    if (selfMatches || convoMatches || childMatches.length > 0) {
      out.push({
        thread: node.thread,
        children: selfMatches ? node.children : childMatches,
      });
    }
  }
  return out;
}

// the flat ordered list of items (threads + convos) whose label directly
// matches the query. arrow nav and the highlight always land on these —
// ancestors that are shown only for path context are skipped. when a
// thread's title matches we also expose all its convos as path context
// only (NOT as navigable matches) -- the user explicitly typed the thread,
// not the convo.
function navigableSearchItems(state: AppState): types.SidebarItem[] {
  const trimmed = state.sidebarSearchQuery.trim().toLowerCase();
  if (!trimmed) return [];
  const tree = pruneTreeByQuery(buildThreadTree(state.threads), trimmed);
  const items = visibleSidebarItems(tree, {}, state.showArchived);
  return items.filter((item) => {
    const thread = state.threads.find((t) => t.id === item.threadId);
    if (!thread) return false;
    if (item.kind === 'thread') return thread.title.toLowerCase().includes(trimmed);
    const convo = thread.convos[item.convoId];
    if (!convo) return false;
    return convoSearchLabel(item.convoId, convo).toLowerCase().includes(trimmed);
  });
}

function sidebarItemKey(item: types.SidebarItem): string {
  return item.kind === 'thread' ? `t:${item.threadId}` : `c:${item.threadId}:${item.convoId}`;
}

export const sidebarSearchItemKey: typeof types.sidebarSearchItemKey = sidebarItemKey;

export const openSidebarSearch: typeof types.openSidebarSearch = (): void => {
  useAppStore.setState({
    sidebarSearchOpen: true,
    sidebarSearchQuery: '',
    sidebarSearchHighlightId: null,
  });
};

// opening search steals DOM focus from whatever pane the user was typing
// in. on close we replay focusedPane so the prior surface gets focus back.
// selectThread also fires the terminal event when applicable, but this
// also covers esc/blur-without-commit and same-thread commits where
// selectThread alone wouldn't refocus the note editor.
function replayPaneFocus(): void {
  const pane = useAppStore.getState().focusedPane;
  const eventName = pane === 'terminal' ? 'threads-terminal-focus' : 'threads-note-focus';
  window.setTimeout(() => window.dispatchEvent(new Event(eventName)), 0);
}

export const closeSidebarSearch: typeof types.closeSidebarSearch = (): void => {
  if (!useAppStore.getState().sidebarSearchOpen) return;
  useAppStore.setState({
    sidebarSearchOpen: false,
    sidebarSearchQuery: '',
    sidebarSearchHighlightId: null,
  });
  replayPaneFocus();
};

export const setSidebarSearchQuery: typeof types.setSidebarSearchQuery = (query: string): void => {
  useAppStore.setState({ sidebarSearchQuery: query });
  // re-anchor the highlight to the new top match if the previous highlight
  // dropped out of the matching set.
  const state = useAppStore.getState();
  const navigable = navigableSearchItems(state);
  if (navigable.length === 0) {
    if (state.sidebarSearchHighlightId !== null) {
      useAppStore.setState({ sidebarSearchHighlightId: null });
    }
    return;
  }
  if (!navigable.some((item) => sidebarItemKey(item) === state.sidebarSearchHighlightId)) {
    useAppStore.setState({
      sidebarSearchHighlightId: sidebarItemKey(navigable[0]!),
    });
  }
};

export const moveSidebarSearchHighlight: typeof types.moveSidebarSearchHighlight = (
  direction: -1 | 1
): void => {
  const state = useAppStore.getState();
  const navigable = navigableSearchItems(state);
  if (navigable.length === 0) return;
  const currentIndex = navigable.findIndex(
    (item) => sidebarItemKey(item) === state.sidebarSearchHighlightId
  );
  const nextIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : navigable.length - 1
      : Math.max(0, Math.min(navigable.length - 1, currentIndex + direction));
  useAppStore.setState({
    sidebarSearchHighlightId: sidebarItemKey(navigable[nextIndex]!),
  });
};

export const commitSidebarSearch: typeof types.commitSidebarSearch = (): void => {
  const state = useAppStore.getState();
  const key = state.sidebarSearchHighlightId;
  useAppStore.setState({
    sidebarSearchOpen: false,
    sidebarSearchQuery: '',
    sidebarSearchHighlightId: null,
  });
  if (key) {
    // resolve the key back into a SidebarItem and route through the unified
    // selection helper so a convo match lands on the convo row, not just on
    // its thread.
    if (key.startsWith('t:')) {
      selectSidebarItem({ kind: 'thread', threadId: key.slice(2) });
    } else if (key.startsWith('c:')) {
      const rest = key.slice(2);
      const sep = rest.indexOf(':');
      if (sep >= 0) {
        selectSidebarItem({
          kind: 'convo',
          threadId: rest.slice(0, sep),
          convoId: rest.slice(sep + 1),
        });
      }
    }
  }
  // restore the prior pane's focus. for cross-thread commits the new pane's
  // mount effect handles it; this covers same-thread commits and the
  // committed-to-note case where selectThread doesn't dispatch on its own.
  replayPaneFocus();
};

export const setNoteDraft: typeof types.setNoteDraft = (note: string): void => {
  const state = useAppStore.getState();
  useAppStore.setState({
    noteDraft: note,
    noteDraftThreadId: state.selectedId,
  });
};

export const saveSelectedThread: typeof types.saveSelectedThread = async (): Promise<void> => {
  const state = useAppStore.getState();
  const threadId = state.noteDraftThreadId ?? state.selectedId;
  if (!threadId) return;
  if (state.noteDraft === state.noteDraftBaseline) return;
  const sentNote = state.noteDraft;
  try {
    const updated = await apiPatch<ThreadRecord>(`/api/threads/${threadId}`, {
      note: sentNote,
    });
    useAppStore.setState((current) => {
      const sameDraft = current.noteDraftThreadId === threadId && current.noteDraft === sentNote;
      return {
        threads: orderedThreads(
          current.threads.map((item) => (item.id === updated.id ? updated : item))
        ),
        noteDraftBaseline: sameDraft ? updated.note : current.noteDraftBaseline,
        noteSaveError: null,
      };
    });
  } catch (error) {
    const message = String(error);
    useAppStore.setState({ noteSaveError: message });
    logActivity('note_save_error', { threadId, message });
  }
};

export const createRootThread: typeof types.createRootThread = async (): Promise<void> => {
  await saveSelectedThread();
  const thread = await apiPost<ThreadRecord>('/api/threads', {
    title: 'new thread',
    note: '# new thread\n',
  });
  useAppStore.setState((state) => ({
    threads: orderedThreads([...state.threads, thread]),
    ...applySelection(thread),
  }));
  logActivity('thread_create', { threadId: thread.id });
};

export const createSubthread: typeof types.createSubthread = async (
  parentId: string
): Promise<void> => {
  await saveSelectedThread();
  const thread = await apiPost<ThreadRecord>('/api/threads', {
    title: 'new thread',
    note: '# new thread\n',
    parentId,
  });
  cancelNeedsReviewClear();
  useAppStore.setState((state) => ({
    threads: orderedThreads([...state.threads, thread]),
    ...applySelection(thread),
  }));
  logActivity('thread_create', { threadId: thread.id, parentId });
};

export const toggleSelectedThreadArchived: typeof types.toggleSelectedThreadArchived =
  async (): Promise<void> => {
    await saveSelectedThread();
    const prevState = useAppStore.getState();
    const thread = prevState.threads.find((item) => item.id === prevState.selectedId);
    if (!thread) return;
    const updated = await apiPatch<ThreadRecord>(`/api/threads/${thread.id}`, {
      archived: !thread.archived,
    });
    const projectedThreads = orderedThreads(
      prevState.threads.map((item) => (item.id === updated.id ? updated : item))
    );
    const reselect = pickNextVisibleSelection(prevState, projectedThreads);
    useAppStore.setState((current) => ({
      threads: orderedThreads(
        current.threads.map((item) => (item.id === updated.id ? updated : item))
      ),
    }));
    if (reselect.needsReselect) {
      if (reselect.nextId) selectThread(reselect.nextId);
      else useAppStore.setState({ ...applySelection(null) });
    }
    logActivity('thread_archive_toggle', {
      threadId: thread.id,
      archived: updated.archived,
    });
  };

export const deleteSelectedThread: typeof types.deleteSelectedThread = async (): Promise<void> => {
  const prevState = useAppStore.getState();
  const thread = prevState.threads.find((item) => item.id === prevState.selectedId);
  if (!thread) return;
  if (prevState.threads.some((other) => other.parentId === thread.id)) {
    window.alert('Has children; archive instead.');
    return;
  }
  if (!window.confirm('Delete this thread? This cannot be undone.')) return;
  try {
    await apiDelete(`/api/threads/${thread.id}`);
  } catch (error) {
    window.alert(`Delete failed: ${String(error)}`);
    return;
  }
  const nextThreads = prevState.threads.filter((item) => item.id !== thread.id);
  const reselect = pickNextVisibleSelection(prevState, nextThreads);
  useAppStore.setState({ threads: nextThreads });
  if (reselect.nextId) selectThread(reselect.nextId);
  else useAppStore.setState({ ...applySelection(null) });
  logActivity('thread_delete', { threadId: thread.id });
};

export const getActiveConvoId: typeof types.getActiveConvoId = (
  state: AppState,
  threadId: string
): string => state.activeConvoByThread[threadId] ?? DEFAULT_CONVO_ID;

export const setActiveConvo: typeof types.setActiveConvo = (
  threadId: string,
  convoId: string
): void => {
  useAppStore.setState((state) => ({
    activeConvoByThread: { ...state.activeConvoByThread, [threadId]: convoId },
  }));
};

export const openConvoTerminal: typeof types.openConvoTerminal = async (args: {
  threadId: string;
  convoId: string;
  kind?: ConvoKind;
  size?: { cols: number; rows: number };
}): Promise<void> => {
  useAppStore.setState({ terminalError: null });
  try {
    const body: Record<string, unknown> = {
      convoId: args.convoId,
    };
    if (args.kind) body.kind = args.kind;
    if (args.size) {
      body.cols = args.size.cols;
      body.rows = args.size.rows;
    }
    const result = await apiPost<{
      token: string;
      convoId: string;
      kind: ConvoKind;
      thread: ThreadRecord;
    }>(`/api/threads/${args.threadId}/terminal`, body);
    const key = convoTokenKey(args.threadId, result.convoId);
    useAppStore.setState((state) => ({
      terminalTokens: { ...state.terminalTokens, [key]: result.token },
      terminalError: null,
      activeConvoByThread: {
        ...state.activeConvoByThread,
        [args.threadId]: result.convoId,
      },
      threads: orderedThreads(
        state.threads.map((item) => (item.id === result.thread.id ? result.thread : item))
      ),
    }));
    logActivity('terminal_open', {
      threadId: args.threadId,
      convoId: result.convoId,
    });
  } catch (error) {
    const message = String(error);
    useAppStore.setState({ terminalError: message });
    logActivity('terminal_open_error', {
      threadId: args.threadId,
      convoId: args.convoId,
      message,
    });
  }
};

export const openThreadTerminal: typeof types.openThreadTerminal = async (
  threadId: string,
  size?: { cols: number; rows: number }
): Promise<void> => openConvoTerminal({ threadId, convoId: DEFAULT_CONVO_ID, size });

export const clearConvoTerminal: typeof types.clearConvoTerminal = (
  threadId: string,
  convoId: string
): void => {
  const key = convoTokenKey(threadId, convoId);
  const state = useAppStore.getState();
  if (!(key in state.terminalTokens)) return;
  const nextTokens = { ...state.terminalTokens };
  delete nextTokens[key];
  useAppStore.setState({
    terminalTokens: nextTokens,
    terminalError: state.terminalError,
  });
  logActivity('terminal_exit', { threadId, convoId });
  void loadThreads();
};

export const clearThreadTerminal: typeof types.clearThreadTerminal = (threadId: string): void =>
  clearConvoTerminal(threadId, DEFAULT_CONVO_ID);

// pick the next unused convo id of the form `<kind>-<n>`. n starts at 1
// (codex-1, codex-2, ...) since 'default' is the always-claude slot. kept
// short so tab labels read clean.
function nextConvoId(thread: ThreadRecord, kind: ConvoKind): string {
  let n = 1;
  while (true) {
    const candidate = `${kind}-${n}`;
    if (!thread.convos[candidate]) return candidate;
    n += 1;
  }
}

export const spawnConvo: typeof types.spawnConvo = async (
  threadId: string,
  kind: ConvoKind
): Promise<void> => {
  const state = useAppStore.getState();
  const thread = state.threads.find((item) => item.id === threadId);
  if (!thread) return;
  const convoId = nextConvoId(thread, kind);
  await openConvoTerminal({ threadId, convoId, kind });
};

// archive a non-default convo: kills its pty and hides it from the active
// sidebar list. recoverable via frontmatter edit. no confirm dialog — the
// archive itself is the safety net.
export const closeConvo: typeof types.closeConvo = async (
  threadId: string,
  convoId: string
): Promise<void> => {
  try {
    await fetch(`/api/threads/${threadId}/convos/${convoId}`, {
      method: 'DELETE',
    });
  } catch (error) {
    logActivity('convo_archive_error', {
      threadId,
      convoId,
      message: String(error),
    });
  }
  const key = convoTokenKey(threadId, convoId);
  useAppStore.setState((state) => {
    const tokens = { ...state.terminalTokens };
    delete tokens[key];
    const activeByThread = { ...state.activeConvoByThread };
    if (activeByThread[threadId] === convoId) {
      // shift focus to the closest non-archived convo sibling so the user
      // keeps a convo row selected when possible; fall back to the thread
      // row only when no sibling remains.
      const thread = state.threads.find((item) => item.id === threadId);
      const sibling = thread ? pickNextNonArchivedConvo(thread, convoId) : null;
      if (sibling) activeByThread[threadId] = sibling;
      else delete activeByThread[threadId];
    }
    return { terminalTokens: tokens, activeConvoByThread: activeByThread };
  });
  logActivity('convo_archive', { threadId, convoId });
  await loadThreads();
};

// optimistic toggle. updates state.threads, tracks the in-flight patch so
// concurrent SSE refetches don't clobber the optimistic value, and on PATCH
// success replaces the thread record with the server's authoritative copy.
async function setThreadPreviewOpen(threadId: string, open: boolean): Promise<void> {
  pendingPreviewOpenPatch.set(threadId, open);
  useAppStore.setState((state) => ({
    threads: state.threads.map((thread) =>
      thread.id === threadId ? { ...thread, previewOpen: open } : thread
    ),
  }));
  try {
    const updated = await apiPatch<ThreadRecord>(`/api/threads/${threadId}`, {
      previewOpen: open,
    });
    if (pendingPreviewOpenPatch.get(threadId) === open) {
      useAppStore.setState((state) => ({
        threads: state.threads.map((thread) => (thread.id === updated.id ? updated : thread)),
      }));
    }
    logActivity('preview_persist_ok', { threadId, open });
  } catch (error) {
    useAppStore.setState((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadId ? { ...thread, previewOpen: !open } : thread
      ),
    }));
    logActivity('preview_persist_error', {
      threadId,
      open,
      message: String(error),
    });
  } finally {
    if (pendingPreviewOpenPatch.get(threadId) === open) {
      pendingPreviewOpenPatch.delete(threadId);
    }
  }
}

export const togglePreviewForSelected: typeof types.togglePreviewForSelected =
  async (): Promise<void> => {
    const state = useAppStore.getState();
    const selected = state.threads.find((thread) => thread.id === state.selectedId);
    if (!selected || !threadHasPreviewConfig(selected)) return;
    const nextOpen = !selected.previewOpen;
    logActivity(nextOpen ? 'preview_open' : 'preview_hide', {
      threadId: selected.id,
    });
    await setThreadPreviewOpen(selected.id, nextOpen);
  };

// fetch the preview URL for a thread and cache it in state.previewUrls. safe
// to call from a useEffect when the iframe needs a src; idempotent for an
// already-cached URL, and the server's ensurePreviewRunning is idempotent for
// an already-running preview process.
const inFlightUrlFetch = new Set<string>();

export const fetchPreviewUrl: typeof types.fetchPreviewUrl = async (
  threadId: string
): Promise<void> => {
  if (inFlightUrlFetch.has(threadId)) return;
  const state = useAppStore.getState();
  const thread = state.threads.find((item) => item.id === threadId);
  if (!thread) return;
  const key = threadPreviewConfigKey(thread);
  const cached = state.previewUrls[threadId];
  if (cached && state.previewConfigKeys[threadId] === key) return;
  inFlightUrlFetch.add(threadId);
  try {
    const result = await apiPost<{ url: string; label?: string }>(
      `/api/threads/${threadId}/preview`
    );
    useAppStore.setState((state) => ({
      previewUrls: { ...state.previewUrls, [threadId]: result.url },
      previewLabels: {
        ...state.previewLabels,
        [threadId]: result.label ?? 'preview',
      },
      previewConfigKeys: { ...state.previewConfigKeys, [threadId]: key },
    }));
  } catch (error) {
    logActivity('preview_fetch_error', { threadId, message: String(error) });
  } finally {
    inFlightUrlFetch.delete(threadId);
  }
};

//
// Hook
//

type Store = AppState & {
  loadThreads: typeof loadThreads;
  selectThread: typeof selectThread;
  navigateThreadHistory: typeof navigateThreadHistory;
  setFocusedPane: typeof setFocusedPane;
  setMobilePane: typeof setMobilePane;
  toggleAncestor: typeof toggleAncestor;
  toggleThreadCollapsed: typeof toggleThreadCollapsed;
  toggleShowArchived: typeof toggleShowArchived;
  toggleAutoCollapseToSelection: typeof toggleAutoCollapseToSelection;
  openSidebarSearch: typeof openSidebarSearch;
  closeSidebarSearch: typeof closeSidebarSearch;
  setSidebarSearchQuery: typeof setSidebarSearchQuery;
  moveSidebarSearchHighlight: typeof moveSidebarSearchHighlight;
  commitSidebarSearch: typeof commitSidebarSearch;
  setNoteDraft: typeof setNoteDraft;
  saveSelectedThread: typeof saveSelectedThread;
  createRootThread: typeof createRootThread;
  createSubthread: typeof createSubthread;
  toggleSelectedThreadArchived: typeof toggleSelectedThreadArchived;
  deleteSelectedThread: typeof deleteSelectedThread;
  openThreadTerminal: typeof openThreadTerminal;
  clearThreadTerminal: typeof clearThreadTerminal;
  openConvoTerminal: typeof openConvoTerminal;
  clearConvoTerminal: typeof clearConvoTerminal;
  setActiveConvo: typeof setActiveConvo;
  spawnConvo: typeof spawnConvo;
  closeConvo: typeof closeConvo;
  togglePreviewForSelected: typeof togglePreviewForSelected;
  fetchPreviewUrl: typeof fetchPreviewUrl;
};

export const useAppStore = create<Store>()(
  persist(
    (): Store => ({
      threads: [],
      selectedId: null,
      ancestorOpen: false,
      collapsedThreadIds: {},
      showArchived: false,
      autoCollapseToSelection: false,
      loading: true,
      error: null,
      noteDraft: '',
      noteDraftThreadId: null,
      noteDraftBaseline: '',
      noteSaveError: null,
      terminalTokens: {},
      activeConvoByThread: {},
      terminalError: null,
      focusedPane: 'note',
      mobilePane: 'sidebar',
      previewUrls: {},
      previewLabels: {},
      previewConfigKeys: {},
      needsReviewIds: {},
      reloadAvailable: false,
      selectedHistory: [],
      selectedHistoryIndex: -1,
      sidebarSearchOpen: false,
      sidebarSearchQuery: '',
      sidebarSearchHighlightId: null,
      loadThreads,
      selectThread,
      navigateThreadHistory,
      setFocusedPane,
      setMobilePane,
      toggleAncestor,
      toggleThreadCollapsed,
      toggleShowArchived,
      toggleAutoCollapseToSelection,
      openSidebarSearch,
      closeSidebarSearch,
      setSidebarSearchQuery,
      moveSidebarSearchHighlight,
      commitSidebarSearch,
      setNoteDraft,
      saveSelectedThread,
      createRootThread,
      createSubthread,
      toggleSelectedThreadArchived,
      deleteSelectedThread,
      openThreadTerminal,
      clearThreadTerminal,
      openConvoTerminal,
      clearConvoTerminal,
      setActiveConvo,
      spawnConvo,
      closeConvo,
      togglePreviewForSelected,
      fetchPreviewUrl,
    }),
    {
      name: 'threads',
      partialize: (state) => ({
        selectedId: state.selectedId,
        ancestorOpen: state.ancestorOpen,
        collapsedThreadIds: state.collapsedThreadIds,
        showArchived: state.showArchived,
        autoCollapseToSelection: state.autoCollapseToSelection,
        needsReviewIds: state.needsReviewIds,
        focusedPane: state.focusedPane,
        mobilePane: state.mobilePane,
        selectedHistory: state.selectedHistory,
        selectedHistoryIndex: state.selectedHistoryIndex,
        activeConvoByThread: state.activeConvoByThread,
      }),
    }
  )
);

//
// Reload Signal
//

// dev-only: vite's HMR socket carries a custom event from the project's vite
// plugin when `npm run reload` is called. surface it as `reloadAvailable` so
// the sidebar can show a click-to-reload icon. nothing auto-reloads.
if (import.meta.hot) {
  import.meta.hot.on('reload-available', () => {
    useAppStore.setState({ reloadAvailable: true });
  });
}
