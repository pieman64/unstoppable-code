import { searchSlashCommands } from './commandSearch';
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
  filteredCommands: TCommand[];
  namespace: string | null;
  backToCommands: () => void;
  selectedIndex: number;
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

  const trigger = enabled ? getTriggerMatch(editor, triggerCharacters) : null;
  const triggerKey = getTriggerKey(trigger);
  const triggerQuery = trigger?.query ?? null;

  useEffect(() => {
    if (triggerKey === null) {
      setDismissedTriggerKey(null);
      setSelectedIndex(0);
    }
  }, [triggerKey]);

  const isOpen = triggerKey !== null && dismissedTriggerKey !== triggerKey;

  const namespace = useMemo(() => {
    const query = (triggerQuery ?? '').toLowerCase();
    return (
      commands.find(
        (command) =>
          command.namespace &&
          (query === command.namespace.toLowerCase() ||
            query.startsWith(`${command.namespace.toLowerCase()}:`)),
      )?.namespace ?? null
    );
  }, [commands, triggerQuery]);
  const filteredCommands = useMemo(() => {
    if (!isOpen) return [];
    const candidates = namespace
      ? commands.filter(
          (command) =>
            command.namespace === namespace && !command.browseNamespace,
        )
      : commands;
    const query = namespace
      ? (triggerQuery ?? '').slice(namespace.length).replace(/^:/, '')
      : (triggerQuery ?? '');
    return searchSlashCommands(candidates, query);
  }, [isOpen, triggerQuery, commands, namespace]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [triggerQuery, filteredCommands.length]);

  const backToCommands = useCallback(() => {
    if (!trigger) return;
    Transforms.select(editor, trigger.range);
    Transforms.insertText(editor, trigger.trigger);
    setDismissedTriggerKey(null);
    setSelectedIndex(0);
  }, [editor, trigger]);

  const clampedIndex = Math.min(
    selectedIndex,
    Math.max(0, filteredCommands.length - 1),
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): boolean => {
      if (!isOpen) return false;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (namespace) backToCommands();
        else setDismissedTriggerKey(triggerKey);
        return true;
      }
      if (filteredCommands.length === 0) return false;

      switch (e.key) {
        case 'ArrowUp': {
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev <= 0 ? filteredCommands.length - 1 : prev - 1,
          );
          return true;
        }
        case 'ArrowDown': {
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev >= filteredCommands.length - 1 ? 0 : prev + 1,
          );
          return true;
        }
        case 'Enter':
        case 'Tab': {
          e.preventDefault();
          return true;
        }
        default:
          return false;
      }
    },
    [isOpen, filteredCommands.length, triggerKey, namespace, backToCommands],
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
    setSelectedIndex(0);
  }, [triggerKey]);

  return {
    isOpen,
    triggerKey,
    filteredCommands,
    namespace,
    backToCommands,
    selectedIndex: clampedIndex,
    isDiscovering,
    onKeyDown,
    selectCommand,
    close,
  };
}
