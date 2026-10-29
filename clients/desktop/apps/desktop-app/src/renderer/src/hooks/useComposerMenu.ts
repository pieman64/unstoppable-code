import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { Editor, Range, Transforms, type RangeRef } from 'slate';
import { ReactEditor } from 'slate-react';
import { focusEditor } from '@canopy/ui-rich/editor';
import type {
  ChatEditor,
  FileMentionOption,
  FileReferenceElement,
} from '@canopy/ui-rich/types';
import { buildFileReferenceDisplayPath } from '@/lib/fileMentionSearch';
import {
  PLUGIN_MENTION_KIND,
  buildPluginMentionAbsolutePath,
  type PluginMentionRef,
} from '@canopy/desktop-shared/lib/plugin-mention';

/** A bounded Slate-point scan preserves inline pills and ignores email/path punctuation. */
function findTrigger(
  editor: ChatEditor,
  dollar: boolean,
): { range: Range; query: string; variant: 'add' | 'commands' } | null {
  if (!editor.selection || !Range.isCollapsed(editor.selection)) return null;
  let point = editor.selection.anchor;
  let query = '';
  for (let count = 0; count < 200; count++) {
    const previous = Editor.before(editor, point, { unit: 'character' });
    if (!previous) return null;
    const character = Editor.string(editor, { anchor: previous, focus: point });
    if (!character || /\s/.test(character)) return null;
    if (
      character === '/' ||
      character === '@' ||
      (dollar && character === '$')
    ) {
      const before = Editor.before(editor, previous, { unit: 'character' });
      if (
        !before ||
        /[\s([{]/.test(
          Editor.string(editor, { anchor: before, focus: previous }),
        )
      ) {
        return {
          range: { anchor: previous, focus: editor.selection.anchor },
          query,
          variant: character === '@' ? 'add' : 'commands',
        };
      }
    }
    query = character + query;
    point = previous;
  }
  return null;
}

export interface ComposerMenuController {
  open: boolean;
  variant: 'add' | 'commands';
  /** Whether the active session came from typed editor input or the + trigger. */
  origin: 'editor' | 'toolbar';
  query: string;
  setQuery: (query: string) => void;
  onOpenChange: (open: boolean) => void;
  consumeTrigger: () => void;
  beginSelection: () => void;
  anchorRef: RefObject<HTMLSpanElement | null>;
  menuRef: RefObject<HTMLDivElement | null>;
  editorRef: RefObject<HTMLElement | null>;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  /**
   * The row under the pointer, reported by the list. Pointer hover clears the
   * keyboard highlight so the hover style shows; Enter (or Tab in a typed
   * session) then activates the hovered row rather than silently falling
   * back to the first one.
   */
  setHoveredId: (id: string | null) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLDivElement>) => boolean;
  prepareAction: () => void;
  /** Replaces the active query and keeps the inserted invocation token separated. */
  insertCommandText: (text: string) => void;
  insertFile: (file: FileMentionOption, repoCount: number) => void;
  /**
   * Insert a whole-plugin mention pill (kind `plugin`) at the trigger, the
   * way `insertFile` inserts a file pill. `label` is the user-facing plugin
   * name and becomes the pill's display token in the serialized text.
   */
  insertPlugin: (plugin: PluginMentionRef & { label: string }) => void;
}

/** One composer-owned dialog session for /, @, $, and the toolbar trigger. */
export function useComposerMenu(
  editor: ChatEditor,
  {
    enabled,
    dollar,
    scopeKey,
    onChange,
  }: {
    enabled: boolean;
    dollar: boolean;
    scopeKey: string;
    onChange: () => void;
  },
): ComposerMenuController {
  const [open, setOpen] = useState(false);
  const [variant, setVariant] = useState<'add' | 'commands'>('add');
  const [query, updateQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const trigger = useRef<RangeRef | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  /**
   * Whether the session is showing no highlight because it had no enabled
   * row to give one to (rows still loading, or a re-projection that briefly
   * emptied the list), as opposed to the pointer clearing it. Only the former
   * is restored when rows arrive.
   */
  const lostHighlight = useRef(false);
  /** Mirror of `activeId` for the row observer, which must not update state from inside an updater. */
  const activeIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  const dismissed = useRef<string | null>(null);
  const fromEditor = useRef(false);
  const selecting = useRef(false);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const children = editor.children;
  const selection = editor.selection;
  const match = useMemo(
    () => (enabled ? findTrigger(editor, dollar) : null),
    // Slate keeps the editor identity stable while replacing these snapshots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, enabled, dollar, children, selection],
  );
  const signature = match ? JSON.stringify(match) : null;
  const signatureRef = useRef(signature);
  signatureRef.current = signature;

  const toolbarRange =
    open && !fromEditor.current ? trigger.current?.current : null;
  const toolbarQuery = toolbarRange ? Editor.string(editor, toolbarRange) : '';

  // Resolve typed triggers before paint, rather than opening one frame later.
  useLayoutEffect(() => {
    try {
      editorRef.current = ReactEditor.toDOMNode(editor, editor);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('Cannot resolve a DOM node from Slate node')
      )
        throw error;
      editorRef.current = null;
      return;
    }
    if (!signature) dismissed.current = null;
    if (!enabled || !editorRef.current.contains(document.activeElement)) return;
    if (selecting.current) {
      if (open || !match || dismissed.current === signature) return;
      selecting.current = false;
    }
    if (open && !fromEditor.current) {
      updateQuery(toolbarQuery);
      return;
    }
    if (!match) {
      if (open) setOpen(false);
      return;
    }
    if (!open && dismissed.current === signature) return;
    trigger.current?.unref();
    trigger.current = Editor.rangeRef(editor, match.range, {
      affinity: 'inward',
    });
    fromEditor.current = true;
    updateQuery(match.query);
    setVariant(match.variant);
    setOpen(true);
  }, [editor, enabled, signature, match, open, toolbarQuery]);

  useLayoutEffect(() => {
    const first = open
      ? (menuRef.current?.querySelector<HTMLButtonElement>(
          '[data-action-row]:not(:disabled)',
        )?.id ?? null)
      : null;
    // An open session with nothing to highlight yet (rows still loading) is
    // waiting for a row, not cleared by the pointer.
    lostHighlight.current = open && first === null;
    activeIdRef.current = first;
    setActiveId(first);
  }, [query, open, variant]);
  useEffect(() => {
    const element = editorRef.current;
    if (!element) return;
    if (open && menuRef.current)
      element.setAttribute('aria-controls', menuRef.current.id);
    else element.removeAttribute('aria-controls');
    if (open && activeId)
      element.setAttribute('aria-activedescendant', activeId);
    else element.removeAttribute('aria-activedescendant');
    return (): void => {
      element.removeAttribute('aria-activedescendant');
      element.removeAttribute('aria-controls');
    };
  }, [open, activeId]);

  // Rows can change while the session stays open: a harness switch
  // re-projects the catalog (often through a momentarily empty list while
  // the next inventory loads), discovery finishes, an inventory broadcast
  // lands. A keyboard highlight that named a row which is no longer listed
  // (or is now disabled) moves to the first enabled row, and a highlight the
  // session lost for want of rows is restored once a row exists, so
  // `aria-activedescendant` never points at a node that is gone and one row
  // stays highlighted. A highlight the pointer cleared is left alone.
  useEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu || typeof MutationObserver === 'undefined') return;
    // Resolved here, not in a state updater: updaters must stay pure, and a
    // same-value update would still re-render the composer once per batch.
    const observer = new MutationObserver((): void => {
      const current = activeIdRef.current;
      if (current !== null) {
        const row = menu.ownerDocument.getElementById(current);
        if (
          row &&
          menu.contains(row) &&
          row.matches('[data-action-row]:not(:disabled)')
        )
          return;
      } else if (!lostHighlight.current) {
        return;
      }
      const first =
        menu.querySelector<HTMLButtonElement>(
          '[data-action-row]:not(:disabled)',
        )?.id ?? null;
      lostHighlight.current = first === null;
      if (first === current) return;
      activeIdRef.current = first;
      setActiveId(first);
    });
    observer.observe(menu, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'id'],
    });
    return (): void => observer.disconnect();
  }, [open]);

  useEffect(() => {
    setOpen(false);
    dismissed.current = signatureRef.current;
    fromEditor.current = false;
    selecting.current = false;
    trigger.current?.unref();
    trigger.current = null;
    return (): void => {
      trigger.current?.unref();
      trigger.current = null;
    };
  }, [scopeKey, enabled]);

  const consumeTrigger = useCallback((): void => {
    selecting.current = true;
    const range = trigger.current?.unref();
    trigger.current = null;
    if (range) {
      Transforms.select(editor, range);
      if (!Range.isCollapsed(range)) Transforms.delete(editor);
    } else if (!editor.selection) {
      Transforms.select(editor, Editor.end(editor, []));
    }
  }, [editor]);

  const onOpenChange = useCallback(
    (next: boolean): void => {
      if (next) {
        setVariant('add');
        fromEditor.current = false;
        selecting.current = false;
        trigger.current?.unref();
        if (!editor.selection)
          Transforms.select(editor, Editor.end(editor, []));
        if (editor.selection) Transforms.collapse(editor, { edge: 'end' });
        if (editor.selection)
          trigger.current = Editor.rangeRef(editor, editor.selection, {
            affinity: 'outward',
          });
        updateQuery('');
        requestAnimationFrame(() => focusEditor(editor));
      } else {
        dismissed.current = signatureRef.current;
        if (!selecting.current) {
          trigger.current?.unref();
          trigger.current = null;
        }
      }
      setOpen(next);
    },
    [editor],
  );

  const beginSelection = useCallback((): void => {
    selecting.current = true;
    const range = trigger.current?.unref();
    trigger.current = range
      ? Editor.rangeRef(editor, range, { affinity: 'inward' })
      : null;
  }, [editor]);

  const setQuery = useCallback(
    (next: string): void => {
      const range = trigger.current?.current;
      if (!range) return;
      const start = fromEditor.current
        ? Editor.after(editor, Range.start(range))
        : Range.start(range);
      if (!start) return;
      Transforms.select(editor, { anchor: start, focus: Range.end(range) });
      Transforms.insertText(editor, next);
      updateQuery(next);
      changeRef.current();
      requestAnimationFrame(() => focusEditor(editor));
    },
    [editor],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      onOpenChange(false);
      return true;
    }
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[data-action-row]:not(:disabled)',
      ) ?? [],
    );
    /** Activates the keyboard highlight, else the hovered row, else the first. */
    const activateRow = (rows: HTMLButtonElement[]): true => {
      event.preventDefault();
      (
        rows.find((button) => button.id === activeId) ??
        rows.find((button) => button.id === hoveredIdRef.current) ??
        rows[0]
      )?.click();
      return true;
    };
    if (event.key === 'Tab') {
      // Plain Tab completes a typed `/`, `@`, or `$` suggestion like Enter,
      // but only suggestion rows: never an action that opens a picker or
      // dialog (Files and folders, Plugins, Linear). Shift+Tab, chords, a +
      // menu session, and a list without suggestions keep Tab as focus
      // navigation so keyboard users can leave the composer.
      const suggestions = buttons.filter((button) =>
        button.hasAttribute('data-completion-row'),
      );
      if (
        fromEditor.current &&
        suggestions.length > 0 &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      )
        return activateRow(suggestions);
      onOpenChange(false);
      return false;
    }
    if (
      !buttons.length &&
      ['Enter', 'ArrowUp', 'ArrowDown'].includes(event.key)
    ) {
      onOpenChange(false);
      return false;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const current = buttons.findIndex((button) => button.id === activeId);
      const index =
        current < 0
          ? event.key === 'ArrowDown'
            ? 0
            : buttons.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
            buttons.length;
      const button = buttons[index];
      setActiveId(button.id);
      button.scrollIntoView({ block: 'nearest' });
      return true;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey)
      return activateRow(buttons);
    return false;
  };

  const setHoveredId = useCallback((id: string | null): void => {
    hoveredIdRef.current = id;
  }, []);
  /** A host-driven highlight change (keyboard or pointer) is never "lost". */
  const setActiveIdExplicit = useCallback((id: string | null): void => {
    lostHighlight.current = false;
    activeIdRef.current = id;
    setActiveId(id);
  }, []);

  const prepareAction = useCallback((): void => {
    consumeTrigger();
    changeRef.current();
  }, [consumeTrigger]);

  const insertCommandText = useCallback(
    (text: string): void => {
      consumeTrigger();
      const point = editor.selection ? Range.start(editor.selection) : null;
      const before = point
        ? Editor.before(editor, point, { unit: 'character' })
        : null;
      const after = point
        ? Editor.after(editor, point, { unit: 'character' })
        : null;
      const previous =
        before && point
          ? Editor.string(editor, { anchor: before, focus: point })
          : '';
      const next =
        point && after
          ? Editor.string(editor, { anchor: point, focus: after })
          : '';
      const leading =
        previous !== '' && !/\s/.test(previous) && !/^\s/.test(text) ? ' ' : '';
      const trailing =
        next !== '' && !/\s/.test(next) && !/\s$/.test(text) ? ' ' : '';
      Transforms.insertText(editor, `${leading}${text}${trailing}`);
      changeRef.current();
      requestAnimationFrame(() => focusEditor(editor));
    },
    [editor, consumeTrigger],
  );

  const insertFile = useCallback(
    (file: FileMentionOption, repoCount: number): void => {
      consumeTrigger();
      const node: FileReferenceElement = {
        type: 'file-reference',
        displayPath: buildFileReferenceDisplayPath(file, repoCount),
        absolutePath: file.absolutePath,
        ...(repoCount > 1 && file.repoName ? { repoName: file.repoName } : {}),
        ...(file.kind !== undefined ? { kind: file.kind } : {}),
        children: [{ text: '' }],
      };
      Transforms.insertNodes(editor, node);
      Transforms.move(editor);
      Transforms.insertText(editor, ' ');
      changeRef.current();
      requestAnimationFrame(() => focusEditor(editor));
    },
    [editor, consumeTrigger],
  );

  const insertPlugin = useCallback(
    (plugin: PluginMentionRef & { label: string }): void => {
      consumeTrigger();
      // The pill's label is inlined verbatim into the sent text, and the
      // transcript chip only matches it at a word boundary, so keep a space
      // between preceding text and the label (`tools @x`, never `toolsx`).
      const start = editor.selection ? Range.start(editor.selection) : null;
      const before = start
        ? Editor.before(editor, start, { unit: 'character' })
        : null;
      const previous =
        before && start
          ? Editor.string(editor, { anchor: before, focus: start })
          : '';
      if (previous !== '' && !/\s/.test(previous)) {
        Transforms.insertText(editor, ' ');
      }
      const node: FileReferenceElement = {
        type: 'file-reference',
        displayPath: plugin.label,
        absolutePath: buildPluginMentionAbsolutePath(plugin),
        kind: PLUGIN_MENTION_KIND,
        children: [{ text: '' }],
      };
      Transforms.insertNodes(editor, node);
      Transforms.move(editor);
      Transforms.insertText(editor, ' ');
      changeRef.current();
      requestAnimationFrame(() => focusEditor(editor));
    },
    [editor, consumeTrigger],
  );

  return {
    open,
    variant,
    origin: fromEditor.current ? 'editor' : 'toolbar',
    query,
    setQuery,
    onOpenChange,
    consumeTrigger,
    beginSelection,
    anchorRef,
    menuRef,
    editorRef,
    activeId,
    setActiveId: setActiveIdExplicit,
    setHoveredId,
    handleKeyDown,
    prepareAction,
    insertCommandText,
    insertFile,
    insertPlugin,
  };
}
