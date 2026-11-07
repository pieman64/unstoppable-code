import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ForwardedRef,
  type JSX,
  type KeyboardEvent,
} from 'react';
import type { Descendant } from 'slate';
import {
  defaultChatPlaceholder,
  useIsPhone,
  useMediaQuery,
} from '@canopy/ui-shared';
import type {
  ChatEditor,
  FileMentionOption,
  SerializedEditorValue,
  SerializedFileReference,
  SlashCommandOption,
  SlashCommandPreparation,
} from '../types';
import { createEmptyValue } from '../types';
import { useFileTypeahead, useSlashCommands } from '../plugins';
import { FileTypeaheadMenu } from './FileTypeaheadMenu';
import { SlashCommandMenu } from './SlashCommandMenu';
import { SlateEditor, type SlateEditorHandle } from './SlateEditor';
import {
  COMPOSER_DENSITY_CLASS_NAMES,
  type ComposerDensity,
} from './composer-density';
import {
  appendFileReference,
  buildEditorValueFromMessage,
  createChatEditor,
  insertTextAtCursor,
  resetEditor,
  restoreEditorContent,
  serializeEditorValue,
} from './slate-utils';
import { usePendingSlashCommand } from './use-pending-slash-command';

/**
 * Imperative handle for the composer editor. Hosts drive the draft from
 * outside React state (send, queue edits, attachments, commands, voice).
 */
export interface ComposerEditorHandle {
  /** The Slate instance itself, for hosts that still transform it directly. */
  readonly editor: ChatEditor;
  /**
   * Insert plain text at the caret. No host calls it yet: it is the seam the
   * next slice moves desktop's voice dictation and history recall onto.
   */
  insertText: (text: string) => void;
  insertFileReference: (ref: SerializedFileReference) => void;
  reset: () => void;
  replaceDraft: (
    text: string,
    fileReferences?: SerializedFileReference[],
  ) => void;
  focus: () => void;
  serialize: () => SerializedEditorValue;
  /**
   * Insert already-completed slash-command text (e.g. `/review `) at the
   * caret. Used by a Commands popup that picks a command outside the inline
   * `/` typeahead flow, so it inserts the finished text directly.
   */
  insertSlashCommand: (insertText: string) => void;
}

export interface ComposerEditorProps {
  /**
   * A host-owned Slate instance. Omit and the editor creates its own. Desktop
   * passes the instance it also hands to voice dictation and history recall.
   */
  editor?: ChatEditor;
  /**
   * Controlled value. When present, the host owns the draft and receives
   * every change through `onChange`; the editor keeps no draft state of its
   * own. When absent, the editor owns the draft and seeds it from
   * `initialText` / `initialFileReferences`.
   */
  value?: Descendant[];
  onChange?: (value: Descendant[]) => void;
  disabled?: boolean;
  /** See {@link SlateEditorProps.typeToFocus}. */
  typeToFocus?: boolean;
  /**
   * Mount-time draft seed (plain text) for the uncontrolled mode. Used when a
   * host remounts the editor on a destination switch but wants the typed
   * draft preserved. Ignored after mount and in controlled mode.
   */
  initialText?: string;
  /**
   * Serialized file references belonging to {@link initialText}, so preserved
   * drafts keep their mention pills (positions come from each reference's
   * `textStart`). Ignored after mount and in controlled mode.
   */
  initialFileReferences?: SerializedFileReference[];
  placeholder?: string;
  /**
   * Vertical density step (see `COMPOSER_DENSITY_CLASS_NAMES`). Desktop picks
   * a smaller step as its panel gets shorter; web stays comfortable.
   */
  density?: ComposerDensity;
  /** Override the density container classes (e.g. to reserve room for a button). */
  containerClassName?: string;
  /** Placement classes for the editor's outer box within the host layout. */
  className?: string;
  /** Override the density editable classes. */
  editableClassName?: string;
  /** Render the draft in the mono face (desktop terminal mode). */
  monospace?: boolean;
  /** Test hook attached to the editable element. */
  dataTestId?: string;
  /**
   * Host-first key handler. Runs before the typeahead and Enter handling
   * below; a host that consumes a key must call `preventDefault()`.
   */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onSelectionChange?: () => void;
  /**
   * Raw paste handler. When present it replaces the `onPasteFiles` path
   * entirely (desktop reads native file paths off the clipboard items).
   */
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  /**
   * Fired on every editor change with the serialized text. Hosts that want
   * to react to typing state (e.g. enabling/disabling Send) consume this.
   */
  onTextChange?: (text: string) => void;
  /**
   * Fired on every editor change with the serialized file references, so
   * hosts tracking a preservable draft can mirror the pill metadata alongside
   * the text.
   */
  onFileReferencesChange?: (fileReferences: SerializedFileReference[]) => void;
  /**
   * Fired when the user presses Enter (without Shift) on a fine pointer.
   * Omit it and Enter is left to the host's `onKeyDown` (or to Slate).
   */
  onSubmit?: (payload: SerializedEditorValue) => void;
  canSubmit?: (payload: SerializedEditorValue) => boolean;
  /** Forward pasted files to the host attachment pipeline. */
  onPasteFiles?: (files: File[]) => void;
  /**
   * Optional slash-command catalog fetcher. The host owns the IO; the
   * editor caches the result for the duration of the active trigger.
   * A new identity means a new catalog scope: an open trigger drops its
   * in-flight request and refetches, so keep the identity stable across
   * renders that do not change the catalog.
   */
  fetchSlashCommands?: () => Promise<SlashCommandOption[]>;
  /**
   * Host gate run before a slash row is inserted. Cloud uses it to enable an
   * available catalog skill and Portal to resolve a row's host text; `false`
   * or a rejection leaves the trigger text untouched.
   */
  onSelectSlashCommand?: (
    command: SlashCommandOption,
  ) => SlashCommandPreparation | Promise<SlashCommandPreparation>;
  /**
   * Optional file-mention search. Receives the typeahead query and returns
   * matching files for the menu.
   */
  searchFileMentions?: (query: string) => Promise<FileMentionOption[]>;
  /** Render a multi-repo header row in the file-mention menu. */
  multiRepo?: boolean;
}

/**
 * The one chat composer editor both hosts render: the shared Slate editor
 * plus the inline `/` command and `@` file-mention typeaheads, the density
 * map, the coarse-pointer Enter rule, and the pasted-files hook.
 *
 * Two ownership modes keep both hosts on it. Web lets the editor own the
 * draft (uncontrolled, seeded by `initialText`). Desktop passes its own
 * Slate instance and controls the value, because it also feeds that instance
 * to voice dictation, message-history recall, and external insert events;
 * the raw `editor` on the handle is the escape hatch for those.
 */
function ComposerEditorInner(
  {
    editor: hostEditor,
    value: controlledValue,
    onChange,
    disabled = false,
    typeToFocus,
    initialText,
    initialFileReferences,
    placeholder,
    density = 'comfortable',
    containerClassName,
    className,
    editableClassName,
    monospace = false,
    dataTestId,
    onKeyDown,
    onSelectionChange,
    onPaste,
    onTextChange,
    onFileReferencesChange,
    onSubmit,
    canSubmit,
    onPasteFiles,
    fetchSlashCommands,
    onSelectSlashCommand,
    searchFileMentions,
    multiRepo = false,
  }: ComposerEditorProps,
  ref: ForwardedRef<ComposerEditorHandle>,
): JSX.Element {
  // The host's instance when it owns one, otherwise one built here once; a
  // host that switches instances gets a fresh fallback, so no cast is needed.
  const editor = useMemo(() => hostEditor ?? createChatEditor(), [hostEditor]);
  const isControlled = controlledValue !== undefined;
  // `initialText`/`initialFileReferences` are a mount-time seed only
  // (preserved drafts across a keyed remount); later prop changes
  // intentionally do not touch the live value.
  const [ownValue, setOwnValue] = useState<Descendant[]>(() =>
    initialText
      ? buildEditorValueFromMessage(initialText, initialFileReferences ?? [])
      : createEmptyValue(),
  );
  const value = isControlled ? controlledValue : ownValue;
  const editorRef = useRef<SlateEditorHandle | null>(null);
  // On touch devices the on-screen keyboard's Return key fires a plain Enter
  // keydown; consuming it as submit made multi-line drafts impossible and
  // sent partial messages (CAN-1987). A coarse primary pointer keeps Enter on
  // Slate's default insertBreak (a line break at the caret) and leaves sending
  // to the explicit Send button. Fine-pointer (desktop keyboard) semantics are
  // unchanged: Enter submits, Shift+Enter inserts the line break.
  const isCoarsePointer = useMediaQuery('(pointer: coarse)');
  // Only the fallback placeholder below reads this; every other treatment in
  // this editor is width-independent.
  const isPhonePlaceholderWidth = useIsPhone();

  /** Publish a new document to whoever owns the draft. */
  const commit = useCallback(
    (next: Descendant[]): void => {
      if (isControlled) {
        onChange?.(next);
      } else {
        setOwnValue(next);
      }
    },
    [isControlled, onChange],
  );

  // Cache the slash-command catalog for the lifetime of an open trigger so
  // typing into the menu doesn't fan out one network round-trip per keystroke.
  const [slashCommands, setSlashCommands] = useState<SlashCommandOption[]>([]);
  const slashLoadedForRef =
    useRef<ComposerEditorProps['fetchSlashCommands']>(undefined);
  const [slashLoading, setSlashLoading] = useState(false);

  // Only a host that supplies a catalog gets the inline `/` flow; a host that
  // owns `/` itself (desktop's composer menu) must not have a second trigger
  // tracker here that could swallow its keys, mirroring the `@` gate below.
  const slash = useSlashCommands(editor, {
    commands: slashCommands,
    isDiscovering: slashLoading,
    enabled: fetchSlashCommands !== undefined,
  });
  // Latest-slash ref so the async enablement gate below inserts through (and
  // checks staleness against) the CURRENT trigger, not the render that
  // started the selection.
  // A query changed away and back is still a different selection session.
  const slashGeneration = useRef(0);
  useEffect(() => {
    slashGeneration.current += 1;
  }, [slash.triggerKey, slash.isOpen]);
  const slashRef = useRef(slash);
  useEffect(() => {
    slashRef.current = slash;
  }, [slash]);

  // Shared enable-before-insert gate (also used by a Commands popup): one
  // pending selection at a time, no insert on failure or staleness.
  const {
    pendingCommand: pendingSlashCommand,
    selectCommand: gateSlashSelect,
  } = usePendingSlashCommand(onSelectSlashCommand);

  const selectSlashCommand = useCallback(
    (command: SlashCommandOption): void => {
      if (command.disabledReason !== undefined) return;
      const triggerKey = slash.triggerKey;
      const generation = slashGeneration.current;
      if (onSelectSlashCommand && triggerKey === null) return;
      gateSlashSelect(
        command,
        (cmd) => slashRef.current.selectCommand(cmd),
        () => {
          // Stale when the trigger closed or was retargeted (different text
          // or range) while the host enablement was in flight.
          const latest = slashRef.current;
          return !(
            latest.isOpen &&
            latest.triggerKey === triggerKey &&
            slashGeneration.current === generation
          );
        },
      );
    },
    [gateSlashSelect, onSelectSlashCommand, slash],
  );

  useEffect(() => {
    if (
      !slash.isOpen ||
      !fetchSlashCommands ||
      slashLoadedForRef.current === fetchSlashCommands
    ) {
      return;
    }
    let cancelled = false;
    slashLoadedForRef.current = fetchSlashCommands;
    setSlashCommands([]);
    setSlashLoading(true);
    fetchSlashCommands()
      .then((commands) => {
        if (!cancelled) {
          setSlashCommands(commands);
        }
      })
      .catch(() => {
        // Swallow the error — the menu shows "No matching commands" when the
        // catalog stays empty, which is the desired UX.
      })
      .finally(() => {
        if (!cancelled) {
          setSlashLoading(false);
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [slash.isOpen, fetchSlashCommands]);

  // File mentions: query the host on every typeahead query change. The host
  // is expected to debounce / cache as appropriate.
  const [mentionResults, setMentionResults] = useState<{
    query: string;
    files: FileMentionOption[];
  } | null>(null);
  const [mentionQueryInFlight, setMentionQueryInFlight] = useState<
    string | null
  >(null);
  const mentionQueryInFlightRef = useRef<string | null>(null);

  const synchronousSearch = useCallback(
    (query: string): FileMentionOption[] => {
      // The shared hook expects a synchronous search; we couple it to the
      // cached `mentionResults` and trigger an async refresh via effect below.
      return mentionResults?.query === query ? mentionResults.files : [];
    },
    [mentionResults],
  );

  const fileTypeahead = useFileTypeahead(editor, {
    enabled: Boolean(searchFileMentions),
    search: synchronousSearch,
    includeRepoName: multiRepo,
  });
  const resolvedPlaceholder =
    placeholder ??
    defaultChatPlaceholder(
      Boolean(fetchSlashCommands),
      Boolean(searchFileMentions),
      isPhonePlaceholderWidth,
    );

  useEffect(() => {
    if (!fileTypeahead.isOpen || !searchFileMentions) {
      return;
    }
    const query = fileTypeahead.query;
    if (mentionQueryInFlightRef.current === query) return;
    mentionQueryInFlightRef.current = query;
    setMentionQueryInFlight(query);
    let cancelled = false;
    searchFileMentions(query)
      .then((results) => {
        if (!cancelled) {
          setMentionResults({ query, files: results });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMentionResults({ query, files: [] });
        }
      })
      .finally(() => {
        if (!cancelled) {
          mentionQueryInFlightRef.current = null;
          setMentionQueryInFlight(null);
        }
      });
    return (): void => {
      cancelled = true;
      if (mentionQueryInFlightRef.current === query) {
        mentionQueryInFlightRef.current = null;
      }
    };
  }, [fileTypeahead.isOpen, fileTypeahead.query, searchFileMentions]);

  // Reset cache when the trigger closes so a re-open re-fetches commands.
  useEffect(() => {
    if (!slash.isOpen) {
      slashLoadedForRef.current = undefined;
    }
  }, [slash.isOpen]);

  const publishSerialized = useCallback((): void => {
    const serialized = serializeEditorValue(editor.children);
    onTextChange?.(serialized.text);
    onFileReferencesChange?.(serialized.fileReferences);
  }, [editor, onFileReferencesChange, onTextChange]);

  const handleChange = useCallback(
    (next: Descendant[]): void => {
      commit([...next]);
      const serialized = serializeEditorValue(next);
      onTextChange?.(serialized.text);
      onFileReferencesChange?.(serialized.fileReferences);
    },
    [commit, onFileReferencesChange, onTextChange],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;
      // Enter and Escape that confirm or dismiss an IME candidate belong to
      // the composition, not to typeaheads or submission.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (fileTypeahead.isOpen && fileTypeahead.onKeyDown(event)) return;
      if (slash.isOpen) {
        // Show all is handled by the hook: Enter expands, Tab is consumed.
        if (
          (event.key === 'Enter' || event.key === 'Tab') &&
          slash.selectedCommand !== null
        ) {
          event.preventDefault();
          selectSlashCommand(slash.selectedCommand);
          return;
        }
        if (slash.onKeyDown(event)) return;
      }
      if (
        onSubmit !== undefined &&
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.metaKey &&
        !isCoarsePointer
      ) {
        event.preventDefault();
        const payload = serializeEditorValue(editor.children);
        if (!(canSubmit?.(payload) ?? payload.text.trim().length > 0)) return;
        onSubmit(payload);
      }
    },
    [
      editor,
      fileTypeahead,
      slash,
      selectSlashCommand,
      onKeyDown,
      onSubmit,
      canSubmit,
      isCoarsePointer,
    ],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>): void => {
      if (onPaste) {
        onPaste(event);
        return;
      }
      const files = Array.from(event.clipboardData.files);
      if (files.length === 0 || onPasteFiles === undefined) return;
      event.preventDefault();
      onPasteFiles(files);
    },
    [onPaste, onPasteFiles],
  );

  useImperativeHandle(
    ref,
    () => ({
      editor,
      insertText: (text: string): void => {
        editorRef.current?.focus();
        insertTextAtCursor(editor, text);
        commit([...editor.children]);
        publishSerialized();
      },
      insertFileReference: (reference: SerializedFileReference): void => {
        editorRef.current?.focus();
        appendFileReference(editor, reference);
        commit([...editor.children]);
        publishSerialized();
      },
      reset: (): void => {
        resetEditor(editor);
        // Commit what the editor actually holds, like every other mutation.
        commit([...editor.children]);
        onTextChange?.('');
        onFileReferencesChange?.([]);
      },
      replaceDraft: (
        text: string,
        fileReferences: SerializedFileReference[] = [],
      ): void => {
        const next = buildEditorValueFromMessage(text, fileReferences);
        restoreEditorContent(editor, next);
        commit([...editor.children]);
      },
      focus: (): void => {
        editorRef.current?.focus();
      },
      serialize: (): SerializedEditorValue =>
        serializeEditorValue(editor.children),
      insertSlashCommand: (insertText: string): void => {
        editorRef.current?.focus();
        insertTextAtCursor(editor, insertText);
        commit([...editor.children]);
        // Same publication as the other inserts: text and file references.
        publishSerialized();
      },
    }),
    [commit, editor, onFileReferencesChange, onTextChange, publishSerialized],
  );

  const densityClasses = COMPOSER_DENSITY_CLASS_NAMES[density];

  return (
    <div
      className={className ? `relative ${className}` : 'relative'}
      aria-disabled={disabled || undefined}
    >
      {fileTypeahead.isOpen && searchFileMentions && (
        <FileTypeaheadMenu
          files={fileTypeahead.filteredFiles}
          selectedIndex={fileTypeahead.selectedIndex}
          isMultiRepo={multiRepo}
          isLoading={mentionQueryInFlight !== null}
          onSelect={fileTypeahead.selectFile}
        />
      )}
      {!fileTypeahead.isOpen && slash.isOpen && fetchSlashCommands && (
        <SlashCommandMenu
          commands={slash.filteredCommands}
          selectedIndex={slash.selectedIndex}
          onHover={slash.setSelectedIndex}
          isDiscovering={slash.isDiscovering}
          itemLabel="commands"
          title="Commands"
          onSelect={selectSlashCommand}
          pendingCommand={pendingSlashCommand}
          hiddenCount={slash.hiddenCount}
          totalCount={slash.totalCount}
          onShowAll={slash.showAll}
        />
      )}
      <SlateEditor
        ref={editorRef}
        editor={editor}
        value={value}
        readOnly={disabled}
        placeholder={resolvedPlaceholder}
        onChange={handleChange}
        onSelectionChange={onSelectionChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        monospace={monospace}
        containerClassName={containerClassName ?? densityClasses.container}
        editableClassName={editableClassName ?? densityClasses.editable}
        dataTestId={dataTestId}
        typeToFocus={typeToFocus}
      />
    </div>
  );
}

export const ComposerEditor = forwardRef<
  ComposerEditorHandle,
  ComposerEditorProps
>(ComposerEditorInner);
ComposerEditor.displayName = 'ComposerEditor';
