import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from 'react';
import { Editor, Range, Transforms } from 'slate';
import type {
  ChatEditor,
  FileMentionOption,
  FileReferenceElement,
} from '../types';

export interface UseFileTypeaheadOptions {
  /** Whether the typeahead should react to `@` triggers. */
  enabled?: boolean;
  /**
   * Host-provided search function. Receives the trigger query (without `@`)
   * and returns ranked completions for the menu. The hook does not perform
   * any IO of its own.
   */
  search: (query: string) => FileMentionOption[];
  /**
   * Builds the `displayPath` written into the editor when a file is picked.
   * Defaults to {@link FileMentionOption.relativePath}.
   */
  buildDisplayPath?: (file: FileMentionOption) => string;
  /**
   * Set to true when the host renders pills for files in multiple repos —
   * makes `repoName` available on the inserted {@link FileReferenceElement}.
   */
  includeRepoName?: boolean;
}

export interface UseFileTypeaheadResult {
  isOpen: boolean;
  query: string;
  filteredFiles: FileMentionOption[];
  selectedIndex: number;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => boolean;
  selectFile: (file: FileMentionOption) => void;
  close: () => void;
}

interface TriggerMatch {
  query: string;
  range: Range;
}

/**
 * Walk backward from the cursor through Slate points (not string offsets)
 * to find an `@` trigger. This correctly handles inline void elements
 * (pills) which occupy a position in Slate's point space but produce no
 * text.
 */
function getTriggerMatch(editor: ChatEditor): TriggerMatch | null {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return null;

  let point = selection.anchor;
  let query = '';

  for (let steps = 0; steps < 200; steps += 1) {
    const prev = Editor.before(editor, point, { unit: 'character' });
    if (!prev) break;

    const char = Editor.string(editor, { anchor: prev, focus: point });

    // Empty string means we crossed a void element — stop searching.
    if (char === '') break;

    // Whitespace before finding `@` means no trigger.
    if (/[\s\n\r]/.test(char)) return null;

    if (char === '@') {
      const beforeAt = Editor.before(editor, prev, { unit: 'character' });
      if (beforeAt) {
        const preChar = Editor.string(editor, {
          anchor: beforeAt,
          focus: prev,
        });
        if (!/[\s\n\r([{]/.test(preChar)) {
          return null;
        }
      }

      return {
        query,
        range: { anchor: prev, focus: selection.anchor },
      };
    }

    query = char + query;
    point = prev;
  }

  return null;
}

export function useFileTypeahead(
  editor: ChatEditor,
  options: UseFileTypeaheadOptions,
): UseFileTypeaheadResult {
  const {
    enabled = true,
    search,
    buildDisplayPath,
    includeRepoName = false,
  } = options;

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);

  const trigger = enabled ? getTriggerMatch(editor) : null;
  const triggerQuery = trigger?.query ?? null;

  useEffect(() => {
    if (triggerQuery === null) {
      setDismissedQuery(null);
      setSelectedIndex(0);
      return;
    }
    if (dismissedQuery !== triggerQuery) {
      setSelectedIndex(0);
    }
  }, [triggerQuery, dismissedQuery]);

  const filteredFiles = useMemo(
    () => (triggerQuery !== null ? search(triggerQuery) : []),
    [triggerQuery, search],
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [triggerQuery, filteredFiles.length]);

  const close = useCallback(() => {
    if (triggerQuery === null) return;
    setDismissedQuery(triggerQuery);
    setSelectedIndex(0);
  }, [triggerQuery]);

  const selectFile = useCallback(
    (file: FileMentionOption) => {
      if (!trigger) return;

      const displayPath = buildDisplayPath
        ? buildDisplayPath(file)
        : file.relativePath;

      const element: FileReferenceElement = {
        type: 'file-reference',
        displayPath,
        absolutePath: file.absolutePath,
        ...(includeRepoName && file.repoName
          ? { repoName: file.repoName }
          : {}),
        ...(file.kind !== undefined ? { kind: file.kind } : {}),
        children: [{ text: '' }],
      };

      Transforms.select(editor, trigger.range);
      Transforms.delete(editor);
      Transforms.insertNodes(editor, element);
      Transforms.move(editor);
      Transforms.insertText(editor, ' ');

      setDismissedQuery(null);
      setSelectedIndex(0);
    },
    [editor, trigger, buildDisplayPath, includeRepoName],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): boolean => {
      if (triggerQuery === null || dismissedQuery === triggerQuery)
        return false;
      if (filteredFiles.length === 0) {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
          return true;
        }
        return false;
      }

      switch (event.key) {
        case 'ArrowUp':
          event.preventDefault();
          setSelectedIndex((prev) =>
            prev <= 0 ? filteredFiles.length - 1 : prev - 1,
          );
          return true;
        case 'ArrowDown':
          event.preventDefault();
          setSelectedIndex((prev) =>
            prev >= filteredFiles.length - 1 ? 0 : prev + 1,
          );
          return true;
        case 'Enter':
        case 'Tab':
          event.preventDefault();
          selectFile(filteredFiles[selectedIndex] ?? filteredFiles[0]);
          return true;
        case 'Escape':
          event.preventDefault();
          close();
          return true;
        default:
          return false;
      }
    },
    [
      close,
      dismissedQuery,
      filteredFiles,
      selectedIndex,
      selectFile,
      triggerQuery,
    ],
  );

  return {
    isOpen: triggerQuery !== null && dismissedQuery !== triggerQuery,
    query: triggerQuery ?? '',
    filteredFiles,
    selectedIndex:
      filteredFiles.length === 0
        ? 0
        : Math.min(selectedIndex, filteredFiles.length - 1),
    onKeyDown,
    selectFile,
    close,
  };
}
