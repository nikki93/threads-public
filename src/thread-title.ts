import type * as types from './_types';

//
// Title Text
//

const FALLBACK_TITLE = 'untitled';

export const cleanThreadTitleLine: typeof types.cleanThreadTitleLine = (line: string): string => {
  const title = line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[\\`*_{}\[\]<>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return title;
};

export const deriveThreadTitle: typeof types.deriveThreadTitle = (
  note: string,
  fallback = FALLBACK_TITLE
): string => {
  const firstLine = note.split(/\r?\n/, 1)[0] ?? '';
  return cleanThreadTitleLine(firstLine) || cleanThreadTitleLine(fallback) || FALLBACK_TITLE;
};
