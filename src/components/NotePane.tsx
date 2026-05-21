import { useEffect, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUpRightFromSquare,
  faBoxArchive,
  faBoxOpen,
  faEllipsisVertical,
  faPlay,
  faPlus,
  faTrash,
} from '@fortawesome/free-solid-svg-icons';
import type * as types from '../_types';
import {
  ancestorChain,
  createSubthread,
  deleteSelectedThread,
  deriveThreadTitle,
  fetchPreviewUrl,
  saveSelectedThread,
  setNoteDraft,
  threadHasPreviewConfig,
  toggleAncestor,
  togglePreviewForSelected,
  toggleSelectedThreadArchived,
  useAppStore,
} from '../store';
import { MarkdownEditor } from './MarkdownEditor';
import { IconButton } from './ui';

//
// Breadcrumb
//

export const AncestorBreadcrumb: typeof types.AncestorBreadcrumb = (): JSX.Element => {
  const threads = useAppStore((state) => state.threads);
  const selectedId = useAppStore((state) => state.selectedId);
  const noteDraft = useAppStore((state) => state.noteDraft);
  const open = useAppStore((state) => state.ancestorOpen);
  const ancestors = selectedId ? ancestorChain(threads, selectedId) : [];
  const selected = threads.find((thread) => thread.id === selectedId);
  const path = selected
    ? [...ancestors, { ...selected, title: deriveThreadTitle(noteDraft, selected.title) }]
    : [];
  const canExpand = ancestors.length > 0;

  return (
    <div className={`ancestor-section${canExpand ? '' : ' is-root'}`}>
      <button
        className="ancestor-toggle"
        type="button"
        onClick={canExpand ? toggleAncestor : undefined}
        disabled={!canExpand}>
        <span className="ancestor-path">
          {path.map((thread, index) => (
            <span key={thread.id}>
              {index > 0 && <span className="ancestor-sep"> / </span>}
              {thread.title}
            </span>
          ))}
        </span>
      </button>
      {open && canExpand && (
        <div className="ancestor-expanded">
          {ancestors.map((ancestor) => (
            <div className="ancestor-card" key={ancestor.id}>
              <div className="ancestor-card-title">{ancestor.title}</div>
              <div className="ancestor-card-snippet">{ancestor.note || '(no note)'}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

//
// Actions
//

function NoteMenu({
  threadId,
  archived,
  hasPreview,
}: {
  threadId: string;
  archived: boolean;
  hasPreview: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const openPreviewInNewTab = async (): Promise<void> => {
    await fetchPreviewUrl(threadId);
    const url = useAppStore.getState().previewUrls[threadId];
    if (url) window.open(url, '_blank');
  };

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
      <IconButton title="more" onClick={() => setOpen((value) => !value)} active={open}>
        <FontAwesomeIcon icon={faEllipsisVertical} />
      </IconButton>
      {open && (
        <div className="menu menu-right">
          {hasPreview && (
            <button
              className="menu-item"
              type="button"
              onClick={() => {
                setOpen(false);
                void openPreviewInNewTab();
              }}>
              <FontAwesomeIcon icon={faArrowUpRightFromSquare} />
              <span>preview in new tab</span>
            </button>
          )}
          <button
            className="menu-item"
            type="button"
            onClick={() => {
              setOpen(false);
              void createSubthread(threadId);
            }}>
            <FontAwesomeIcon icon={faPlus} />
            <span>create subthread</span>
          </button>
          <button
            className="menu-item"
            type="button"
            onClick={() => {
              setOpen(false);
              void toggleSelectedThreadArchived();
            }}>
            <FontAwesomeIcon icon={archived ? faBoxOpen : faBoxArchive} />
            <span>{archived ? 'unarchive' : 'archive'}</span>
          </button>
          <button
            className="menu-item"
            type="button"
            onClick={() => {
              setOpen(false);
              void deleteSelectedThread();
            }}>
            <FontAwesomeIcon icon={faTrash} />
            <span>delete</span>
          </button>
        </div>
      )}
    </div>
  );
}

//
// Note
//

export const NotePane: typeof types.NotePane = (): JSX.Element => {
  const thread = useAppStore((state) => state.threads.find((item) => item.id === state.selectedId));
  const note = useAppStore((state) => state.noteDraft);
  const noteDraftThreadId = useAppStore((state) => state.noteDraftThreadId);
  const noteSaveError = useAppStore((state) => state.noteSaveError);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    const flushDraft = (): void => {
      void saveSelectedThread();
    };
    const flushOnHidden = (): void => {
      if (document.visibilityState === 'hidden') flushDraft();
    };
    window.addEventListener('pagehide', flushDraft);
    document.addEventListener('visibilitychange', flushOnHidden);
    return () => {
      window.removeEventListener('pagehide', flushDraft);
      document.removeEventListener('visibilitychange', flushOnHidden);
    };
  }, []);

  useEffect(() => {
    if (!thread) return;
    if (noteDraftThreadId !== thread.id) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveSelectedThread();
    }, 650);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [note, noteDraftThreadId, thread?.id]);

  if (!thread) return <main className="middle" />;
  const hasPreview = threadHasPreviewConfig(thread);
  const previewOpen = thread.previewOpen;

  return (
    <main className="middle">
      <div className="note-actions">
        {noteSaveError && (
          <div className="note-save-error" title={noteSaveError}>
            save failed
          </div>
        )}
        {hasPreview && (
          <IconButton
            title={previewOpen ? 'hide preview' : 'show preview'}
            onClick={() => void togglePreviewForSelected()}
            active={previewOpen}>
            <FontAwesomeIcon icon={faPlay} />
          </IconButton>
        )}
        <NoteMenu threadId={thread.id} archived={thread.archived} hasPreview={hasPreview} />
      </div>
      <div className="middle-body">
        <div className="bubble">
          <AncestorBreadcrumb />
          <MarkdownEditor
            key={thread.id}
            threadId={thread.id}
            value={note}
            onChange={setNoteDraft}
          />
        </div>
      </div>
    </main>
  );
};
