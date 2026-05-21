import { useEffect } from 'react';
import type * as types from '../_types';
import {
  buildThreadTree,
  convoTokenKey,
  currentSidebarItem,
  DEFAULT_CONVO_ID,
  loadThreads,
  navigateThreadHistory,
  needsReviewKey,
  nonDefaultConvoIds,
  openConvoTerminal,
  openSidebarSearch,
  selectSidebarItem,
  setFocusedPane,
  setMobilePane,
  threadHasPreviewConfig,
  toggleAutoCollapseToSelection,
  togglePreviewForSelected,
  toggleShowArchived,
  toggleThreadCollapsed,
  useAppStore,
  visibleSidebarItems,
} from '../store';
import { logActivity } from '../activity';
import { ErrorBoundary } from './ErrorBoundary';
import { NotePane } from './NotePane';
import { PreviewPane } from './PreviewPane';
import { Sidebar } from './Sidebar';
import { TerminalPane } from './TerminalPane';

//
// Keyboard
//

function targetIsTextInput(event: KeyboardEvent): boolean {
  const el = event.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

function paneShortcutIndex(event: KeyboardEvent): string | null {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return null;
  if (event.key === '1' || event.key === '2' || event.key === '3') return event.key;
  if (event.code === 'Digit1') return '1';
  if (event.code === 'Digit2') return '2';
  if (event.code === 'Digit3') return '3';
  return null;
}

function focusInbox(): void {
  // sidebar isn't a "pane" in the focusedPane sense — clear the terminal
  // preference so subsequent arrow-nav from the sidebar doesn't yank focus
  // back into the terminal.
  setFocusedPane('note');
  const target =
    document.querySelector<HTMLButtonElement>('.sidebar .row-shell.selected .row') ??
    document.querySelector<HTMLButtonElement>('.sidebar .row') ??
    document.querySelector<HTMLButtonElement>('.sidebar .icon-btn');
  target?.focus();
}

function focusNoteEditor(): void {
  setFocusedPane('note');
  window.dispatchEvent(new Event('threads-note-focus'));
}

function focusTerminal(): void {
  setFocusedPane('terminal');
  window.dispatchEvent(new Event('threads-terminal-focus'));
}

function focusTerminalAfterRender(): void {
  window.setTimeout(focusTerminal, 40);
  window.setTimeout(focusTerminal, 140);
}

function focusTerminalForSelectedThread(): void {
  const state = useAppStore.getState();
  const item = currentSidebarItem(state);
  if (!item) return;
  const threadId = item.threadId;
  const convoId = item.kind === 'convo' ? item.convoId : DEFAULT_CONVO_ID;
  const key = convoTokenKey(threadId, convoId);
  if (state.terminalTokens[key]) {
    focusTerminal();
    logActivity('focus_shortcut', { target: 'terminal', threadId, convoId });
    return;
  }
  setFocusedPane('terminal');
  void openConvoTerminal({ threadId, convoId }).then(focusTerminalAfterRender);
  logActivity('focus_shortcut', {
    target: 'terminal_launch',
    threadId,
    convoId,
  });
}

function focusPane(index: string): void {
  const state = useAppStore.getState();
  if (index === '1') {
    focusInbox();
    logActivity('focus_shortcut', {
      target: 'inbox',
      threadId: state.selectedId,
    });
    return;
  }
  if (index === '2') {
    focusNoteEditor();
    logActivity('focus_shortcut', {
      target: 'note',
      threadId: state.selectedId,
    });
    return;
  }
  if (index === '3') focusTerminalForSelectedThread();
}

//
// Effects
//

// ios safari's address bar and on-screen keyboard cover part of the layout
// viewport without shrinking `100vh` / `100dvh`. mirror `visualViewport.height`
// into a `--app-h` custom property so the mobile layout actually fits inside
// the visible region.
function useVisualViewportHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = (): void => {
      document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
}

function useThreadEvents(): void {
  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    let reconnectTimer: number | undefined;

    function connect(): void {
      if (cancelled) return;
      source = new EventSource('/api/events');
      source.onmessage = () => void loadThreads();
      source.onerror = () => {
        // EventSource auto-reconnects on most failures, but on server restarts
        // or certain network errors it drops to CLOSED and stops. recycle.
        source?.close();
        source = null;
        if (reconnectTimer) window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(connect, 1000);
      };
    }

    function onVisible(): void {
      if (document.visibilityState === 'visible') void loadThreads();
    }

    void loadThreads();
    connect();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      source?.close();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}

function sidebarItemKey(item: types.SidebarItem): string {
  return item.kind === 'thread' ? `t:${item.threadId}` : `c:${item.threadId}:${item.convoId}`;
}

function visibleItemsForState(state: types.AppState): types.SidebarItem[] {
  // in auto-collapse mode alt-nav walks every item (full tree); the
  // displayed expansion re-derives around wherever the selection lands.
  const collapsed = state.autoCollapseToSelection ? {} : state.collapsedThreadIds;
  return visibleSidebarItems(buildThreadTree(state.threads), collapsed, state.showArchived);
}

function currentSidebarIndex(state: types.AppState, items: types.SidebarItem[]): number {
  const current = currentSidebarItem(state);
  const currentKey = current ? sidebarItemKey(current) : null;
  return currentKey ? items.findIndex((item) => sidebarItemKey(item) === currentKey) : -1;
}

function navigateThreadByDelta(delta: 1 | -1): boolean {
  const state = useAppStore.getState();
  const items = visibleItemsForState(state);
  if (items.length === 0) return false;
  const index = currentSidebarIndex(state, items);
  const nextIndex =
    index === -1 ? 0 : delta === 1 ? Math.min(index + 1, items.length - 1) : Math.max(index - 1, 0);
  const next = items[nextIndex];
  if (!next) return false;
  selectSidebarItem(next);
  return true;
}

function isAltArrowOnly(event: KeyboardEvent): boolean {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false;
  return event.key === 'ArrowUp' || event.key === 'ArrowDown';
}

function isShiftAltArrowOnly(event: KeyboardEvent): boolean {
  if (!event.altKey || !event.shiftKey || event.metaKey || event.ctrlKey) return false;
  return event.key === 'ArrowUp' || event.key === 'ArrowDown';
}

function isMetaAltArrowOnly(event: KeyboardEvent): boolean {
  if (!event.altKey || !event.metaKey || event.ctrlKey || event.shiftKey) return false;
  return event.key === 'ArrowUp' || event.key === 'ArrowDown';
}

// alt+[ / alt+]. matched by `event.code` so the keystroke survives shifted
// or alt-modified layouts where the `key` value would change.
function isAltBracket(event: KeyboardEvent): -1 | 1 | null {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return null;
  if (event.code === 'BracketLeft' || event.key === '[') return -1;
  if (event.code === 'BracketRight' || event.key === ']') return 1;
  return null;
}

// alt+<letter>, matched by `event.code` so the keystroke survives
// option-modified macOS layouts where `event.key` becomes a glyph.
function isAltLetter(event: KeyboardEvent, code: string): boolean {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false;
  return event.code === code;
}

// cmd+alt+up collapses the selected thread; cmd+alt+down expands it. no-op
// if it has no children or is already in the requested state.
function collapseOrExpandSelected(direction: 'collapse' | 'expand'): boolean {
  const state = useAppStore.getState();
  if (!state.selectedId) return false;
  const tree = buildThreadTree(state.threads);
  const findNode = (
    nodes: ReturnType<typeof buildThreadTree>,
    id: string
  ): ReturnType<typeof buildThreadTree>[number] | null => {
    for (const node of nodes) {
      if (node.thread.id === id) return node;
      const inChild = findNode(node.children, id);
      if (inChild) return inChild;
    }
    return null;
  };
  const node = findNode(tree, state.selectedId);
  if (!node) return false;
  const visibleChildren = state.showArchived
    ? node.children
    : node.children.filter((child) => !child.thread.archived);
  const convoIds = nonDefaultConvoIds(node.thread, state.showArchived);
  if (visibleChildren.length === 0 && convoIds.length === 0) return false;
  const collapsed = state.collapsedThreadIds[state.selectedId] === true;
  if (direction === 'collapse' && collapsed) return false;
  if (direction === 'expand' && !collapsed) return false;
  toggleThreadCollapsed(state.selectedId);
  return true;
}

function threadForItem(state: types.AppState, item: types.SidebarItem): types.ThreadRecord | null {
  return state.threads.find((thread) => thread.id === item.threadId) ?? null;
}

function sidebarItemIsActive(state: types.AppState, item: types.SidebarItem): boolean {
  const thread = threadForItem(state, item);
  if (!thread) return false;
  const convoId = item.kind === 'thread' ? DEFAULT_CONVO_ID : item.convoId;
  const convo = thread.convos[convoId];
  const needsReview = !!state.needsReviewIds[needsReviewKey(thread.id, convoId)];
  if (item.kind === 'thread') {
    return thread.isWorking || thread.notify || !!convo?.isWorking || needsReview;
  }
  return !!convo?.isWorking || needsReview;
}

function navigateToNextActiveSidebarItem(delta: 1 | -1): boolean {
  const state = useAppStore.getState();
  const items = visibleItemsForState(state);
  if (items.length === 0) return false;
  const index = currentSidebarIndex(state, items);
  const start = index === -1 ? (delta === 1 ? -1 : items.length) : index;
  for (let i = start + delta; i >= 0 && i < items.length; i += delta) {
    const item = items[i];
    if (!item || !sidebarItemIsActive(state, item)) continue;
    selectSidebarItem(item);
    return true;
  }
  return false;
}

function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const paneIndex = paneShortcutIndex(event);
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === ' ' || event.code === 'Space')
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openSidebarSearch();
        return;
      }
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 't'
      ) {
        event.preventDefault();
        window.parent.postMessage({ type: 'threads-preview-toggle-focus' }, '*');
        return;
      }
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'p'
      ) {
        event.preventDefault();
        void togglePreviewForSelected();
        return;
      }
      if (paneIndex) {
        event.preventDefault();
        event.stopPropagation();
        focusPane(paneIndex);
        return;
      }
      if (isAltLetter(event, 'KeyC')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleAutoCollapseToSelection();
        return;
      }
      if (isAltLetter(event, 'KeyA')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleShowArchived();
        return;
      }
      {
        const dir = isAltBracket(event);
        if (dir !== null) {
          event.preventDefault();
          event.stopImmediatePropagation();
          navigateThreadHistory(dir);
          return;
        }
      }
      if (isMetaAltArrowOnly(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        collapseOrExpandSelected(event.key === 'ArrowUp' ? 'collapse' : 'expand');
        return;
      }
      if (isShiftAltArrowOnly(event)) {
        // always eat the keystroke globally so panes (codemirror, xterm)
        // don't receive it -- even when there's no active thread in the
        // direction, doing nothing is the right behavior here.
        event.preventDefault();
        event.stopImmediatePropagation();
        navigateToNextActiveSidebarItem(event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (isAltArrowOnly(event)) {
        if (navigateThreadByDelta(event.key === 'ArrowDown' ? 1 : -1)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      if (
        targetIsTextInput(event) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      if (navigateThreadByDelta(event.key === 'ArrowDown' ? 1 : -1)) event.preventDefault();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, []);
}

//
// Mobile Top Tabs
//

function TabIcon({ name }: { name: 'list' | 'note' | 'hash' }): JSX.Element {
  // inline lucide-style icons; lucide-react isn't in deps.
  if (name === 'list') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true">
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3" y1="6" x2="3.01" y2="6" />
        <line x1="3" y1="12" x2="3.01" y2="12" />
        <line x1="3" y1="18" x2="3.01" y2="18" />
      </svg>
    );
  }
  if (name === 'note') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="16" y2="17" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  );
}

export const MobileTopTabs: typeof types.MobileTopTabs = (): JSX.Element => {
  const mobilePane = useAppStore((state) => state.mobilePane);
  const tap = (pane: 'sidebar' | 'note' | 'terminal'): void => {
    setMobilePane(pane);
    if (pane === 'note') {
      setFocusedPane('note');
      window.setTimeout(() => window.dispatchEvent(new Event('threads-note-focus')), 0);
    } else if (pane === 'terminal') {
      setFocusedPane('terminal');
      window.setTimeout(() => window.dispatchEvent(new Event('threads-terminal-focus')), 0);
    }
  };
  return (
    <div className="mobile-top-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={mobilePane === 'sidebar'}
        className={`mobile-top-tab${mobilePane === 'sidebar' ? ' is-active' : ''}`}
        onClick={() => tap('sidebar')}
        title="threads">
        <TabIcon name="list" />
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mobilePane === 'note'}
        className={`mobile-top-tab${mobilePane === 'note' ? ' is-active' : ''}`}
        onClick={() => tap('note')}
        title="note">
        <TabIcon name="note" />
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mobilePane === 'terminal'}
        className={`mobile-top-tab${mobilePane === 'terminal' ? ' is-active' : ''}`}
        onClick={() => tap('terminal')}
        title="convo">
        <TabIcon name="hash" />
      </button>
    </div>
  );
};

//
// App
//

export const App: typeof types.App = (): JSX.Element => {
  useThreadEvents();
  useGlobalKeys();
  useVisualViewportHeight();
  useEffect(() => logActivity('page_mount'), []);
  // focus restore after reload: each pane self-focuses on mount when
  // `focusedPane` matches (see MarkdownEditor and TerminalView). App used to
  // dispatch focus events here, but neither pane is mounted yet at App's
  // mount, so those dispatches were lost.
  const previewVisible = useAppStore((state) => {
    const selected = state.threads.find((thread) => thread.id === state.selectedId);
    return !!selected && selected.previewOpen && threadHasPreviewConfig(selected);
  });
  const mobilePane = useAppStore((state) => state.mobilePane);

  return (
    <>
      <MobileTopTabs />
      <div
        className={`app layout-${previewVisible ? 'preview' : 'split'}`}
        data-mobile-pane={mobilePane}>
        <ErrorBoundary label="sidebar">
          <Sidebar />
        </ErrorBoundary>
        <div className="middle-stack">
          <ErrorBoundary label="note">
            <NotePane />
          </ErrorBoundary>
          <ErrorBoundary label="terminal">
            <TerminalPane />
          </ErrorBoundary>
        </div>
        {previewVisible && (
          <ErrorBoundary label="preview">
            <PreviewPane />
          </ErrorBoundary>
        )}
      </div>
    </>
  );
};
