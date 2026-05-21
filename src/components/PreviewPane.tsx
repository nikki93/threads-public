import { useEffect } from 'react';
import type * as types from '../_types';
import { fetchPreviewUrl, useAppStore } from '../store';

export const PreviewPane: typeof types.PreviewPane = (): JSX.Element => {
  const selectedId = useAppStore((state) => state.selectedId);
  const url = useAppStore((state) => (selectedId ? state.previewUrls[selectedId] : undefined));

  useEffect(() => {
    if (selectedId && !url) void fetchPreviewUrl(selectedId);
  }, [selectedId, url]);

  return (
    <section className="preview-pane">
      {url ? (
        <iframe key={selectedId ?? 'none'} className="preview-iframe" src={url} title="preview" />
      ) : (
        <div className="preview-loading">starting preview…</div>
      )}
    </section>
  );
};
