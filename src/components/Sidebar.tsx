import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowsRotate,
  faBoxArchive,
  faChevronDown,
  faChevronRight,
  faCircle,
  faGear,
  faHashtag,
  faMagnifyingGlass,
  faPlus,
  faToggleOff,
  faToggleOn,
} from '@fortawesome/free-solid-svg-icons';
import type * as types from '../_types';
import type { ConvoKind, ConvoState, ThreadRecord, ThreadTreeNode } from '../_types';
import {
  buildThreadTree,
  closeSidebarSearch,
  closeConvo,
  commitSidebarSearch,
  createRootThread,
  createSubthread,
  DEFAULT_CONVO_ID,
  effectiveCollapsedMap,
  getActiveConvoId,
  matchingConvoIds,
  moveSidebarSearchHighlight,
  needsReviewKey,
  nonDefaultConvoIds,
  openSidebarSearch,
  pruneTreeByQuery,
  selectSidebarItem,
  setSidebarSearchQuery,
  sidebarSearchItemKey,
  spawnConvo,
  toggleAutoCollapseToSelection,
  toggleShowArchived,
  toggleThreadCollapsed,
  useAppStore,
} from '../store';
import { IconButton } from './ui';

//
// Rows
//

function convoLabel(convoId: string, convo: ConvoState): string {
  if (convo.name) return convo.name;
  if (convoId === DEFAULT_CONVO_ID) return convo.kind;
  return convoId;
}

function ConvoRow({
  thread,
  convoId,
  convo,
}: {
  thread: ThreadRecord;
  convoId: string;
  convo: ConvoState;
}): JSX.Element {
  const selected = useAppStore(
    (state) => state.selectedId === thread.id && getActiveConvoId(state, thread.id) === convoId
  );
  const itemKey = sidebarSearchItemKey({
    kind: 'convo',
    threadId: thread.id,
    convoId,
  });
  const highlighted = useAppStore(
    (state) => state.sidebarSearchOpen && state.sidebarSearchHighlightId === itemKey
  );
  const reviewKey = needsReviewKey(thread.id, convoId);
  const needsReview = useAppStore((state) => !!state.needsReviewIds[reviewKey]);
  const isWorking = !!convo.isWorking;
  const progress = convo.progress ?? 0;
  const showNeedsReview = needsReview && !isWorking;
  const hasIndicator = isWorking || showNeedsReview || thread.notify;
  const showPie = isWorking && progress > 0 && !convo.archived;
  return (
    <div className="sidebar-node convo-node">
      <div
        className={`row-shell convo-row${selected ? ' selected' : ''}${highlighted ? ' search-highlight' : ''}${convo.archived ? ' archived' : ''}`}>
        <span className="row-disclosure leaf convo-bullet">
          <FontAwesomeIcon icon={faHashtag} />
        </span>
        <button
          className="row convo-button"
          type="button"
          onClick={() => selectSidebarItem({ kind: 'convo', threadId: thread.id, convoId })}>
          <span className="row-title">{convoLabel(convoId, convo)}</span>
          <span
            className="icon-btn row-plus row-close"
            role="button"
            tabIndex={-1}
            title="archive convo"
            aria-label="archive convo"
            onClick={(event) => {
              event.stopPropagation();
              event.preventDefault();
              void closeConvo(thread.id, convoId);
            }}>
            <FontAwesomeIcon icon={faBoxArchive} />
          </span>
          {hasIndicator && (
            <span className="row-indicators">
              {isWorking &&
                (showPie ? (
                  <span
                    className="progress-pie"
                    style={{ ['--progress' as string]: String(progress) }}
                  />
                ) : (
                  <span className="spinner" />
                ))}
              {showNeedsReview && <span className="needs-review-dot" />}
              {thread.notify && <span className="notify-dot" />}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}

function SpawnConvoMenu({ thread }: { thread: ThreadRecord }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // measure the trigger's screen-space position on open so the portal'd menu
  // sits directly under it. layout effect runs before paint so the menu
  // doesn't flash at the wrong position.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    setAnchorRect(triggerRef.current.getBoundingClientRect());
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [open]);
  const spawn = (kind: ConvoKind): void => {
    setOpen(false);
    void spawnConvo(thread.id, kind);
  };
  return (
    <>
      <span
        ref={triggerRef}
        className={`icon-btn row-plus row-plus-convo${open ? ' is-open' : ''}`}
        role="button"
        tabIndex={-1}
        title="new convo"
        aria-label="new convo"
        onMouseDown={(event) => {
          // suppress the .row button click that would otherwise fire on
          // mousedown bubbling. stopPropagation here also keeps the
          // outside-click handler from immediately closing the menu we're
          // about to open.
          event.stopPropagation();
          event.preventDefault();
        }}
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          setOpen((value) => !value);
        }}>
        <FontAwesomeIcon icon={faHashtag} />
      </span>
      {open &&
        anchorRect &&
        createPortal(
          <div
            ref={menuRef}
            className="menu sidebar-spawn-menu"
            style={{
              left: Math.round(anchorRect.left),
              top: Math.round(anchorRect.bottom + 2),
            }}>
            <button type="button" className="menu-item" onClick={() => spawn('claude')}>
              <span>+ claude</span>
            </button>
            <button type="button" className="menu-item" onClick={() => spawn('codex')}>
              <span>+ codex</span>
            </button>
          </div>,
          document.body
        )}
    </>
  );
}

export const SidebarRow: typeof types.SidebarRow = ({
  node,
}: {
  node: ThreadTreeNode;
}): JSX.Element | null => {
  const thread = node.thread;
  const selectedId = useAppStore((state) => state.selectedId);
  // effective map: the selection-derived map when auto-collapse mode is on,
  // else the manual collapsed map.
  const collapsedState = useAppStore((state) => effectiveCollapsedMap(state)[thread.id] ?? false);
  const showArchived = useAppStore((state) => state.showArchived);
  const needsReview = useAppStore(
    (state) => !!state.needsReviewIds[needsReviewKey(thread.id, DEFAULT_CONVO_ID)]
  );
  // during search the user wants to see matches even under collapsed parents.
  // the parent toolbar passes an already-pruned tree, so just expand all.
  const searchActive = useAppStore(
    (state) => state.sidebarSearchOpen && state.sidebarSearchQuery.trim() !== ''
  );
  const searchQuery = useAppStore((state) =>
    state.sidebarSearchOpen ? state.sidebarSearchQuery : ''
  );
  const threadItemKey = sidebarSearchItemKey({
    kind: 'thread',
    threadId: thread.id,
  });
  const highlighted = useAppStore(
    (state) => state.sidebarSearchOpen && state.sidebarSearchHighlightId === threadItemKey
  );
  const collapsed = searchActive ? false : collapsedState;
  // a thread row is "selected" only when no convo is currently active for it
  // (i.e. it represents the default convo). picking a convo row sets
  // activeConvoByThread, which un-selects the thread row.
  const threadActiveConvoId = useAppStore((state) => state.activeConvoByThread[thread.id]);
  if (thread.archived && !showArchived) return null;
  const selected =
    selectedId === thread.id && (!threadActiveConvoId || threadActiveConvoId === DEFAULT_CONVO_ID);
  const visibleChildren = showArchived
    ? node.children
    : node.children.filter((child) => !child.thread.archived);
  // when search is active and this thread's title doesn't directly match,
  // narrow the convo list to those whose label matches the query so the
  // path-context view doesn't drown the actual match in unrelated rows.
  const trimmedQuery = searchQuery.trim();
  const threadTitleMatches =
    !trimmedQuery || thread.title.toLowerCase().includes(trimmedQuery.toLowerCase());
  const extraConvoIds =
    trimmedQuery && !threadTitleMatches
      ? matchingConvoIds(thread, trimmedQuery)
      : nonDefaultConvoIds(thread, showArchived);
  const hasChildren = visibleChildren.length > 0 || extraConvoIds.length > 0;
  const showNeedsReview = needsReview && !thread.isWorking;
  const hasIndicator = thread.isWorking || showNeedsReview || thread.notify;
  const defaultConvoProgress = thread.convos[DEFAULT_CONVO_ID]?.progress ?? 0;
  const showThreadPie = thread.isWorking && defaultConvoProgress > 0;
  return (
    <div className="sidebar-node">
      <div
        className={`row-shell${selected ? ' selected' : ''}${highlighted ? ' search-highlight' : ''}${thread.archived ? ' archived' : ''}`}>
        <button
          className={`row-disclosure${hasChildren ? '' : ' leaf'}`}
          type="button"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            if (hasChildren) toggleThreadCollapsed(thread.id);
          }}>
          <FontAwesomeIcon
            icon={hasChildren ? (collapsed ? faChevronRight : faChevronDown) : faCircle}
          />
        </button>
        <button
          className="row"
          type="button"
          onClick={() => selectSidebarItem({ kind: 'thread', threadId: thread.id })}>
          <span className="row-title">{thread.title}</span>
          <span
            className="icon-btn row-plus"
            role="button"
            tabIndex={-1}
            title="create subthread"
            aria-label="create subthread"
            onClick={(event) => {
              event.stopPropagation();
              event.preventDefault();
              void createSubthread(thread.id);
            }}>
            <FontAwesomeIcon icon={faPlus} />
          </span>
          <SpawnConvoMenu thread={thread} />
          {hasIndicator && (
            <span className="row-indicators">
              {thread.isWorking &&
                (showThreadPie ? (
                  <span
                    className="progress-pie"
                    style={{
                      ['--progress' as string]: String(defaultConvoProgress),
                    }}
                  />
                ) : (
                  <span className="spinner" />
                ))}
              {showNeedsReview && <span className="needs-review-dot" />}
              {thread.notify && <span className="notify-dot" />}
            </span>
          )}
        </button>
      </div>
      {hasChildren && !collapsed && (
        <div className="sidebar-children">
          {extraConvoIds.map((convoId) => (
            <ConvoRow
              key={`convo:${convoId}`}
              thread={thread}
              convoId={convoId}
              convo={thread.convos[convoId]!}
            />
          ))}
          {visibleChildren.map((child) => (
            <SidebarRow key={child.thread.id} node={child} />
          ))}
        </div>
      )}
    </div>
  );
};

//
// Settings Menu
//

function SidebarSettingsMenu(): JSX.Element {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const showArchived = useAppStore((state) => state.showArchived);
  const autoCollapse = useAppStore((state) => state.autoCollapseToSelection);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div className="menu-wrap" ref={menuRef}>
      <IconButton title="settings" onClick={() => setOpen((value) => !value)} active={open}>
        <FontAwesomeIcon icon={faGear} />
      </IconButton>
      {open && (
        <div className="menu">
          <button
            className="menu-item"
            type="button"
            onClick={() => {
              setOpen(false);
              toggleShowArchived();
            }}>
            <span>show archived</span>
            <FontAwesomeIcon
              className="menu-item-toggle"
              data-on={showArchived ? 'true' : 'false'}
              icon={showArchived ? faToggleOn : faToggleOff}
            />
          </button>
          <button
            className="menu-item"
            type="button"
            onClick={() => {
              setOpen(false);
              toggleAutoCollapseToSelection();
            }}>
            <span>auto-collapse to selection</span>
            <FontAwesomeIcon
              className="menu-item-toggle"
              data-on={autoCollapse ? 'true' : 'false'}
              icon={autoCollapse ? faToggleOn : faToggleOff}
            />
          </button>
        </div>
      )}
    </div>
  );
}

//
// Search Field
//

function SidebarSearchField(): JSX.Element {
  const query = useAppStore((state) => state.sidebarSearchQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <input
      ref={inputRef}
      className="sidebar-search-input"
      type="text"
      placeholder="search"
      value={query}
      onChange={(event) => setSidebarSearchQuery(event.target.value)}
      onBlur={closeSidebarSearch}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          inputRef.current?.blur();
          return;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          moveSidebarSearchHighlight(1);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          moveSidebarSearchHighlight(-1);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          commitSidebarSearch();
        }
      }}
    />
  );
}

//
// Sidebar
//

export const Sidebar: typeof types.Sidebar = (): JSX.Element => {
  const threads = useAppStore((state) => state.threads);
  const reloadAvailable = useAppStore((state) => state.reloadAvailable);
  const searchOpen = useAppStore((state) => state.sidebarSearchOpen);
  const searchQuery = useAppStore((state) => state.sidebarSearchQuery);
  const fullTree = buildThreadTree(threads);
  const tree =
    searchOpen && searchQuery.trim() ? pruneTreeByQuery(fullTree, searchQuery) : fullTree;
  return (
    <aside className="sidebar">
      <div className="sidebar-toolbar">
        {searchOpen ? (
          <SidebarSearchField />
        ) : (
          <>
            <SidebarSettingsMenu />
            {reloadAvailable && (
              <IconButton title="reload suggested" onClick={() => window.location.reload()}>
                <FontAwesomeIcon className="reload-icon" icon={faArrowsRotate} />
              </IconButton>
            )}
            <span className="sidebar-toolbar-spacer" />
            <IconButton title="search threads (ctrl+space)" onClick={openSidebarSearch}>
              <FontAwesomeIcon icon={faMagnifyingGlass} />
            </IconButton>
            <IconButton title="new thread" onClick={() => void createRootThread()}>
              <FontAwesomeIcon icon={faPlus} />
            </IconButton>
          </>
        )}
      </div>
      <div className="sidebar-list">
        {tree.map((node) => (
          <SidebarRow key={node.thread.id} node={node} />
        ))}
      </div>
    </aside>
  );
};
