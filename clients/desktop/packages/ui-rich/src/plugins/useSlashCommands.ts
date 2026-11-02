import { searchSlashCommands } from './commandSearch';
import { normalizeSearchText } from './commandSearchIdentity';
import { limitSlashResults, slashCommandGroupKey } from './commandPresentation';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from 'react';
import { Editor, Range, Transforms, type Point } from 'slate';
import type {
  ChatEditor,
  SlashCommandOption,
  SlashCommandTriggerCharacter,
} from '../types';

interface CommandTriggerMatch {
  query: string;
  range: Range;
  trigger: SlashCommandTriggerCharacter;
}

export interface UseSlashCommandsOptions<
  TCommand extends SlashCommandOption = SlashCommandOption,
> {
  /** Slash-command menu options to filter against the current trigger query. */
  commands: TCommand[];
  /** True while the host is loading/discovering commands. */
  isDiscovering?: boolean;
  /** Trigger characters; defaults to `['/']`. */
  triggerCharacters?: readonly SlashCommandTriggerCharacter[];
  /**
   * When false the hook never detects a trigger, so a host that owns the
   * slash flow itself (desktop's composer menu) gets no second state machine
   * over the same text and no key handling. Defaults to true.
   */
  enabled?: boolean;
}

export interface UseSlashCommandsResult<
  TCommand extends SlashCommandOption = SlashCommandOption,
> {
  isOpen: boolean;
  /** Stable identity for the current trigger text and range. */
  triggerKey: string | null;
  /** Visible command rows; capped for typed searches until Show all. */
  filteredCommands: TCommand[];
  /** Ranked rows hidden by the cap; Show all renders only when positive. */
  hiddenCount: number;
  /** Every ranked row, for the `Show all N` label. */
  totalCount: number;
  /** Expands the capped list and selects the first previously hidden row. */
  showAll: () => void;
  /** True when keyboard selection is on Show all rather than a command. */
  isShowAllSelected: boolean;
  /** The selected command row, or null when Show all is selected. */
  selectedCommand: TCommand | null;
  namespace: string | null;
  backToCommands: () => void;
  selectedIndex: number;
  /** Shares pointer selection with keyboard handling, including Show all. */
  setSelectedIndex: (index: number) => void;
  isDiscovering: boolean;
  /** Handle keyboard events — returns true if the event was consumed. */
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => boolean;
  /** Replaces the trigger range with the selected command's insertion text. */
  selectCommand: (cmd: TCommand) => void;
  close: () => void;
}

const DEFAULT_TRIGGER_CHARACTERS: readonly SlashCommandTriggerCharacter[] = [
  '/',
  '$',
];

function isWhitespace(char: string): boolean {
  return /[\s\n\r]/.test(char);
}

function isTriggerBoundary(char: string): boolean {
  return /[\s\n\r([{]/.test(char);
}

function matchTriggerCharacter(
  char: string,
  triggerCharacters: readonly SlashCommandTriggerCharacter[],
): SlashCommandTriggerCharacter | null {
  for (const trigger of triggerCharacters) {
    if (char === trigger) {
      return trigger;
    }
  }
  return null;
}

function pointKey(point: Point): string {
  return `${point.path.join('.')}:${point.offset}`;
}

function getTriggerKey(trigger: CommandTriggerMatch | null): string | null {
  if (!trigger) {
    return null;
  }
  return [
    trigger.trigger,
    trigger.query,
    pointKey(Range.start(trigger.range)),
    pointKey(Range.end(trigger.range)),
  ].join(':');
}

export function getSlashCommandInsertText(
  cmd: SlashCommandOption,
  trigger: SlashCommandTriggerCharacter = '/',
): string {
  // TODO(REG-2877): the fallback is Claude-shaped, but server-emitted rows
  // always set `insertText`. Kept here when the portal composer's duplicate
  // was folded onto this one, so the ticket keeps an anchor at the code.
  return cmd.insertText ?? `${trigger}${cmd.name} `;
}

export function extractCommandPrefix(
  text: string,
  triggerCharacters: readonly SlashCommandTriggerCharacter[] = DEFAULT_TRIGGER_CHARACTERS,
): string | null {
  let query = '';

  for (let index = text.length; index > 0; index -= 1) {
    const char = text.charAt(index - 1);

    if (isWhitespace(char)) {
      return null;
    }

    const trigger = matchTriggerCharacter(char, triggerCharacters);
    if (trigger) {
      if (index > 1) {
        const previousChar = text.charAt(index - 2);
        if (!isTriggerBoundary(previousChar)) {
          return null;
        }
      }
      return query;
    }

    query = char + query;
  }

  return null;
}

function getTriggerMatch(
  editor: ChatEditor,
  triggerCharacters: readonly SlashCommandTriggerCharacter[],
): CommandTriggerMatch | null {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) {
    return null;
  }

  let point = selection.anchor;
  let query = '';

  for (let steps = 0; steps < 200; steps += 1) {
    const previous = Editor.before(editor, point, { unit: 'character' });
    if (!previous) {
      break;
    }

    const char = Editor.string(editor, { anchor: previous, focus: point });

    if (char === '') {
      break;
    }

    if (isWhitespace(char)) {
      return null;
    }

    const trigger = matchTriggerCharacter(char, triggerCharacters);
    if (trigger) {
      const beforeTrigger = Editor.before(editor, previous, {
        unit: 'character',
      });
      if (beforeTrigger) {
        const previousChar = Editor.string(editor, {
          anchor: beforeTrigger,
          focus: previous,
        });
        if (!isTriggerBoundary(previousChar)) {
          return null;
        }
      }

      return {
        query,
        range: { anchor: previous, focus: selection.anchor },
        trigger,
      };
    }

    query = char + query;
    point = previous;
  }

  return null;
}

export function useSlashCommands<
  TCommand extends SlashCommandOption = SlashCommandOption,
>(
  editor: ChatEditor,
  options: UseSlashCommandsOptions<TCommand>,
): UseSlashCommandsResult<TCommand> {
  const {
    commands,
    isDiscovering = false,
    triggerCharacters = DEFAULT_TRIGGER_CHARACTERS,
    enabled = true,
  } = options;

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissedTriggerKey, setDismissedTriggerKey] = useState<string | null>(
    null,
  );
  // Expansion belongs to one trigger text and range, so any query change,
  // retarget or close collapses the list again.
  const [expandedTriggerKey, setExpandedTriggerKey] = useState<string | null>(
    null,
  );

  const trigger = enabled ? getTriggerMatch(editor, triggerCharacters) : null;
  const triggerKey = getTriggerKey(trigger);
  const triggerQuery = trigger?.query ?? null;

  useEffect(() => {
    setExpandedTriggerKey(null);
    if (triggerKey === null) {
      setDismissedTriggerKey(null);
      setSelectedIndex(0);
    }
  }, [triggerKey]);

  const isOpen = triggerKey !== null && dismissedTriggerKey !== triggerKey;

  // Only an explicit `plugin:` prefix scopes the menu; a bare plugin name is
  // an ordinary search ranked across the whole catalog.
  const namespace = useMemo(() => {
    const query = (triggerQuery ?? '').toLowerCase();
    return (
      commands.find(
        (command) =>
          command.namespace &&
          query.startsWith(`${command.namespace.toLowerCase()}:`),
      )?.namespace ?? null
    );
  }, [commands, triggerQuery]);
  const { ranked, isTypedSearch } = useMemo(() => {
    if (!isOpen) return { ranked: [], isTypedSearch: false };
    const candidates = namespace
      ? commands.filter(
          (command) =>
            command.namespace === namespace && !command.browseNamespace,
        )
      : commands;
    const query = namespace
      ? (triggerQuery ?? '').slice(namespace.length + 1)
      : (triggerQuery ?? '');
    return {
      ranked: searchSlashCommands(candidates, query),
      isTypedSearch: normalizeSearchText(query).length > 0,
    };
  }, [isOpen, triggerQuery, commands, namespace]);
  const isExpanded = triggerKey !== null && expandedTriggerKey === triggerKey;
  const { visible: filteredCommands, hiddenCount } = useMemo(
    () =>
      isTypedSearch && !isExpanded
        ? limitSlashResults(ranked, slashCommandGroupKey)
        : { visible: ranked, hiddenCount: 0 },
    [ranked, isTypedSearch, isExpanded],
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [triggerQuery]);

  const backToCommands = useCallback(() => {
    if (!trigger) return;
    Transforms.select(editor, trigger.range);
    Transforms.insertText(editor, trigger.trigger);
    setDismissedTriggerKey(null);
    setSelectedIndex(0);
  }, [editor, trigger]);

  const showAll = useCallback(() => {
    if (triggerKey === null || hiddenCount === 0) return;
    const shown = new Set(filteredCommands);
    const firstHidden = ranked.findIndex((command) => !shown.has(command));
    setExpandedTriggerKey(triggerKey);
    setSelectedIndex(Math.max(0, firstHidden));
  }, [triggerKey, hiddenCount, filteredCommands, ranked]);

  // Show all is one extra navigable position after the command rows.
  const optionCount = filteredCommands.length + (hiddenCount > 0 ? 1 : 0);
  const clampedIndex = Math.min(selectedIndex, Math.max(0, optionCount - 1));
  const isShowAllSelected =
    hiddenCount > 0 && clampedIndex === filteredCommands.length;
  const selectedCommand = isShowAllSelected
    ? null
    : (filteredCommands[clampedIndex] ?? null);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): boolean => {
      if (!isOpen) return false;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (namespace) backToCommands();
        else setDismissedTriggerKey(triggerKey);
        return true;
      }
      if (optionCount === 0) return false;

      switch (e.key) {
        case 'ArrowUp': {
          e.preventDefault();
          setSelectedIndex(
            clampedIndex <= 0 ? optionCount - 1 : clampedIndex - 1,
          );
          return true;
        }
        case 'ArrowDown': {
          e.preventDefault();
          setSelectedIndex(
            clampedIndex >= optionCount - 1 ? 0 : clampedIndex + 1,
          );
          return true;
        }
        case 'Enter':
        case 'Tab': {
          // Enter expands Show all; Tab never activates it, but is consumed
          // so the open menu stays put.
          e.preventDefault();
          if (e.key === 'Enter' && isShowAllSelected) showAll();
          return true;
        }
        default:
          return false;
      }
    },
    [
      isOpen,
      optionCount,
      clampedIndex,
      isShowAllSelected,
      showAll,
      triggerKey,
      namespace,
      backToCommands,
    ],
  );

  const selectCommand = useCallback(
    (cmd: TCommand): void => {
      if (!trigger || cmd.disabledReason !== undefined) {
        return;
      }

      Transforms.select(editor, trigger.range);
      Transforms.delete(editor);
      Transforms.insertText(
        editor,
        cmd.browseNamespace
          ? `${trigger.trigger}${cmd.browseNamespace}:`
          : getSlashCommandInsertText(cmd, trigger.trigger),
      );
      setDismissedTriggerKey(null);
      setSelectedIndex(0);
    },
    [editor, trigger],
  );

  const close = useCallback(() => {
    if (triggerKey !== null) {
      setDismissedTriggerKey(triggerKey);
    }
    setExpandedTriggerKey(null);
    setSelectedIndex(0);
  }, [triggerKey]);

  return {
    isOpen,
    triggerKey,
    filteredCommands,
    hiddenCount,
    totalCount: ranked.length,
    showAll,
    isShowAllSelected,
    selectedCommand,
    namespace,
    backToCommands,
    selectedIndex: clampedIndex,
    setSelectedIndex,
    isDiscovering,
    onKeyDown,
    selectCommand,
    close,
  };
}
