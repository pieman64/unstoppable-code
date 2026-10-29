import { useCallback } from 'react';
import type { RepoFileIndex } from '@canopy/desktop-shared/types';
import {
  useFileTypeahead as sharedUseFileTypeahead,
  type UseFileTypeaheadResult,
} from '@canopy/ui-rich/plugins';
import type { ChatEditor, FileMentionOption } from '@canopy/ui-rich/types';
import {
  buildFileReferenceDisplayPath,
  searchFileMentions,
} from '@/lib/fileMentionSearch';

/**
 * Desktop wrapper around the shared `useFileTypeahead` hook. Owns the
 * adapter that converts the desktop's repo-aware {@link RepoFileIndex} into
 * the shared {@link FileMentionOption} contract, plus the desktop's
 * multi-repo display-path rule. `extraSearch` lets hosts append additional
 * candidate groups (workspace notes/prompts/attachments) after the repo file
 * hits.
 */
export function useFileTypeahead(
  editor: ChatEditor,
  repos: RepoFileIndex[],
  enabled: boolean,
  extraSearch?: (query: string) => FileMentionOption[],
): UseFileTypeaheadResult {
  const search = useCallback(
    (query: string): FileMentionOption[] => [
      ...searchFileMentions(query, repos, 50),
      ...(extraSearch ? extraSearch(query) : []),
    ],
    [repos, extraSearch],
  );

  const buildDisplayPath = useCallback(
    (file: FileMentionOption): string =>
      buildFileReferenceDisplayPath(file, repos.length),
    [repos.length],
  );

  return sharedUseFileTypeahead(editor, {
    enabled,
    search,
    buildDisplayPath,
    includeRepoName: repos.length > 1,
  });
}
