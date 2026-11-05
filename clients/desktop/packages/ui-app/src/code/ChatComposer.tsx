'use client';

import { useSuggestionsClaimApi } from '../suggestions/SuggestionsProvider';

import {
  Button,
  ComposerTipArbiterProvider,
} from '@canopy/ui-shared/components';
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { usePlanModeSuggestion } from './composer/usePlanModeSuggestion';
import { usePlanModeHintStore } from './composer/PlanModeHintContext';
import { PlanModeHint } from './composer/PlanModeHint';
import { useComposerHintActivity } from './composer/useComposerHintActivity';
import type { PortalChatThinkingLevel } from '@canopy/protocol/portal';
import {
  normalizeThinkingForUi,
  THINKING_LEVEL_LABELS,
} from '@canopy/protocol/thinking';
import { defaultChatPlaceholder } from '@canopy/ui-shared/lib';
import { resolveComposerThinking } from './composer/composer-helpers';
import {
  ChatComposerToolbar,
  PlanModeIcon,
  type ChatComposerToolbarChipConfig,
  type ChatThinkingProviderHint,
} from '@canopy/ui-shared';
// The `AppIcons` binding: the package barrel's `ThinkingIcon` is the
// legacy two-lobe glyph that transcript thinking blocks still use.
import { ThinkingIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  FileTypeaheadMenu,
  SlashCommandMenu,
  SlateEditor,
  createChatEditor,
  createEmptyValue,
  serializeEditorValue,
  useFileTypeahead,
  useSlashCommands,
  type FileMentionOption,
  type SlashCommandOption,
  type SlashCommandTriggerCharacter,
} from '@canopy/ui-rich';

/** The Slate editor value shape (avoids a direct `slate` import). */
type EditorValue = ReturnType<typeof createEmptyValue>;

/**
 * The chat composer: the shared `@canopy/ui-rich` Slate editor plus the
 * send/stop control and the plan-mode / thinking-level chips. Using the shared
 * rich editor (instead of a plain textarea) closes the biggest desktop/web
 * parity gap for the shared ChatPanel — multiline rich input, plus the slash-
 * command and `@`-mention typeaheads when the host provides their data.
 *
 * It owns only its draft value; every action is an injected callback and every
 * setting is a prop, so it is host-agnostic. Send affordances are gated by
 * omission: a read-only host passes no `onSend`, disabling the control. The
 * typeaheads are likewise opt-in — the slash menu activates only when
 * `slashCommands` is passed, and the `@`-mention menu only when `fileSearch`
 * is passed, so a host that wires neither renders a plain rich editor.
 */
export interface ChatComposerProps {
  /** Send the drafted text. Omit to disable sending (read-only host). */
  readonly onSend?: (text: string) => void | Promise<void>;
  /** Stop the in-flight turn. Shown in place of Send while `isStreaming`. */
  readonly onStop?: () => void;
  readonly isStreaming?: boolean;
  readonly planMode?: boolean;
  readonly onTogglePlanMode?: () => void;
  readonly onEnablePlanMode?: () => boolean | Promise<boolean>;
  readonly draftKey?: string;
  readonly planAvailable?: boolean;
  readonly thinkingLevel?: PortalChatThinkingLevel;
  readonly onCycleThinking?: () => void;
  /**
   * Provider type for the thinking-level display clamp: Codex has no `max`
   * level, so a persisted `max` (e.g. after a provider switch) displays as
   * `xhigh` — mirrors the portal composer and the desktop cycler.
   */
  readonly providerType?: ChatThinkingProviderHint;
  readonly placeholder?: string;
  /** Fully disable the composer (e.g. while the thread is loading). */
  readonly disabled?: boolean;
  /**
   * Slash-command rows. Passing this (even empty) enables the slash menu; the
   * host owns discovery. The menu filters/inserts against the trigger query.
   */
  readonly slashCommands?: SlashCommandOption[];
  /** True while the host is still discovering slash commands. */
  readonly slashDiscovering?: boolean;
  /** Trigger characters for the slash menu; defaults to `['/']`. */
  readonly slashTriggerCharacters?: readonly SlashCommandTriggerCharacter[];
  /** Optional refresh action rendered in the slash-menu header. */
  readonly onRefreshSlashCommands?: () => void;
  /**
   * Host file-search for the `@`-mention typeahead. Passing this enables the
   * menu; the fn receives the query (without `@`) and returns ranked matches.
   */
  readonly fileSearch?: (query: string) => FileMentionOption[];
  /** True when files span multiple repos (shows repo group headers). */
  readonly fileTypeaheadMultiRepo?: boolean;
  /** True while the host is still building the file index. */
  readonly fileTypeaheadLoading?: boolean;
}

// The editable owns the composer's min/max height, overflow, and padding, so
// the SlateEditor container is kept to click-to-focus only — passing an
// explicit containerClassName suppresses DEFAULT_CONTAINER_CLASS_NAME, whose
// min-h-26 + px-4 would otherwise dominate the height and double the pad.
const CONTAINER_CLASS = 'cursor-text';
const EDITABLE_CLASS =
  'min-h-11 max-h-64 overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-1 py-1 text-s leading-5 fg-primary outline-none placeholder:fg-secondary';
// A single stable empty array so the slash hook's `commands` dep identity does
// not churn every render when no host commands are supplied. The hook never
// mutates it.
const NO_COMMANDS: SlashCommandOption[] = [];

// Active chip treatments mirror the semantic warning tokens used by the
// portal composer, with the rainbow gradient reserved for `max`. The portal's
// `BrainIcon active` glyph and trailing `ThinkingDots` remain local to
// chat-input.tsx; promote them into ui-shared if this composer gains a host.
// The rainbow runs through the theme's own hue ramps at 35%, so it follows
// the theme and colour mode like every other surface.
const MAX_THINKING_RAINBOW_HUES = [
  'red',
  'orange',
  'green',
  'cyan',
  'blue',
  'purple',
] as const;
const MAX_THINKING_ACTIVE_STYLE: CSSProperties = {
  backgroundImage: `linear-gradient(90deg, ${MAX_THINKING_RAINBOW_HUES.map(
    (hue) =>
      `color-mix(in oklab, var(--primitive-${hue}-500) 35%, transparent)`,
  ).join(', ')})`,
  color: 'var(--fg-warning)',
};

export function ChatComposer(props: ChatComposerProps): JSX.Element {
  return (
    <ComposerTipArbiterProvider>
      <ChatComposerContent {...props} />
    </ComposerTipArbiterProvider>
  );
}

function ChatComposerContent({
  onSend,
  onStop,
  isStreaming = false,
  planMode = false,
  onTogglePlanMode,
  onEnablePlanMode,
  draftKey = 'chat',
  planAvailable = false,
  thinkingLevel,
  onCycleThinking,
  providerType,
  placeholder,
  disabled = false,
  slashCommands,
  slashDiscovering = false,
  slashTriggerCharacters,
  onRefreshSlashCommands,
  fileSearch,
  fileTypeaheadMultiRepo = false,
  fileTypeaheadLoading = false,
}: ChatComposerProps): JSX.Element {
  // Remounting the editor (bumping the key + recreating the instance) is the
  // reliable way to clear an uncontrolled Slate editor after a send.
  const [editorKey, setEditorKey] = useState(0);
  // `editorKey` is an intentional dep: bumping it on send is what recreates the
  // editor instance so the remounted SlateEditor starts from an empty draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const editor = useMemo(() => createChatEditor(), [editorKey]);
  const [value, setValue] = useState<EditorValue>(() => createEmptyValue());
  // A ref mirrors the value so `send` reads the freshest draft without taking
  // `value` as a dependency (which would recreate the send/keydown callbacks
  // on every keystroke).
  const valueRef = useRef<EditorValue>(value);

  const slashEnabled = slashCommands !== undefined;
  const slash = useSlashCommands(editor, {
    commands: slashCommands ?? NO_COMMANDS,
    isDiscovering: slashDiscovering,
    triggerCharacters: slashTriggerCharacters,
  });

  const fileEnabled = fileSearch !== undefined;
  const noFiles = useCallback((): FileMentionOption[] => [], []);
  const fileTypeahead = useFileTypeahead(editor, {
    enabled: fileEnabled,
    search: fileSearch ?? noFiles,
    includeRepoName: fileTypeaheadMultiRepo,
  });
  // One placeholder table for every composer: this used to keep its own copy
  // whose bare fallback read `Send a message…` while both hosts said
  // `Send a message` (web chat parity, slice 3). The table's phone forms stay
  // unreached here on purpose — this composer has no width awareness, and a
  // host that needs them passes `placeholder` itself.
  const resolvedPlaceholder =
    placeholder ?? defaultChatPlaceholder(slashEnabled, fileEnabled);

  const handleChange = useCallback((next: EditorValue): void => {
    valueRef.current = next;
    setValue(next);
  }, []);

  const send = useCallback((): void => {
    const trimmed = serializeEditorValue(valueRef.current).text.trim();
    if (trimmed.length === 0 || onSend === undefined || disabled) {
      return;
    }
    const sent = onSend(trimmed);
    if (sent !== undefined) void sent.catch(() => undefined);
    const empty = createEmptyValue();
    valueRef.current = empty;
    setValue(empty);
    setEditorKey((key) => key + 1);
  }, [onSend, disabled]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      // A disabled composer accepts no input at all — the editor is also
      // rendered read-only below, this guards the send/typeahead key paths.
      if (disabled) {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
        }
        return;
      }
      // Typeaheads consume navigation/selection keys first, so Enter picks a
      // menu item (not send) while a menu is open. `useFileTypeahead` inserts
      // the selection on Enter/Tab itself; `useSlashCommands` only consumes
      // Enter/Tab (it does not insert), so the host must perform the slash
      // selection here — mirrors the desktop-native ChatInput.
      if (fileTypeahead.onKeyDown(event)) {
        return;
      }
      // Show all is handled by the hook: Enter expands, Tab is consumed.
      if (
        slash.isOpen &&
        slash.selectedCommand !== null &&
        (event.key === 'Enter' || event.key === 'Tab')
      ) {
        event.preventDefault();
        slash.selectCommand(slash.selectedCommand);
        return;
      }
      if (slash.onKeyDown(event)) {
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    },
    [disabled, fileTypeahead, slash, send],
  );

  const draftText = useMemo(
    () => serializeEditorValue(value).text.trim(),
    [value],
  );
  const hintRootRef = useRef<HTMLDivElement>(null);
  const hintActivity = useComposerHintActivity(
    hintRootRef,
    !disabled && onSend !== undefined,
  );
  const hint = usePlanModeSuggestion({
    suggestionsClaimApi: useSuggestionsClaimApi(),
    text: draftText,
    draftKey: `${draftKey}:${editorKey}`,
    activationKey: providerType,
    planMode,
    planAvailable: planAvailable && onEnablePlanMode !== undefined,
    planReadOnly: false,
    pipelineMode: false,
    ...hintActivity,
    store: usePlanModeHintStore(),
    onEnablePlanMode: onEnablePlanMode ?? ((): boolean => false),
    focusComposer: () =>
      hintRootRef.current
        ?.querySelector<HTMLElement>('[contenteditable="true"]')
        ?.focus(),
  });
  const canSend = draftText.length > 0 && onSend !== undefined && !disabled;

  // `resolveComposerThinking` owns the provider fallback both hosts use (Codex
  // shows a stored `max` as `xhigh`), and the label comes from the shared
  // table. The local versions capitalized the level by hand, which had no
  // entry for `low` and would have rendered it as a tier the UI does not have.
  const displayThinkingLevel =
    thinkingLevel === undefined
      ? undefined
      : resolveComposerThinking({
          current: normalizeThinkingForUi(thinkingLevel),
          executionHarness: providerType,
        }).display;
  const thinkingLabel =
    displayThinkingLevel === undefined || displayThinkingLevel === 'off'
      ? undefined
      : THINKING_LEVEL_LABELS[displayThinkingLevel];

  // Chips stay gated by omission: a host that passes no toggle/cycle handler
  // renders no chip at all (read-only or settings-less hosts).
  const planChip: ChatComposerToolbarChipConfig | undefined = onTogglePlanMode
    ? {
        onClick: onTogglePlanMode,
        disabled,
        active: planMode,
        ariaPressed: planMode,
        activeTone: 'warning',
        title: planMode ? 'Disable plan mode' : 'Enable plan mode',
        ariaLabel: 'Toggle plan mode',
        icon: <PlanModeIcon width={13} height={13} active={planMode} />,
        label: planMode ? 'Plan' : undefined,
        dataTestId: 'chat-composer-plan',
      }
    : undefined;
  const thinkingChip: ChatComposerToolbarChipConfig | undefined =
    displayThinkingLevel !== undefined && onCycleThinking
      ? {
          onClick: onCycleThinking,
          disabled,
          active: displayThinkingLevel !== 'off',
          activeTone: displayThinkingLevel === 'max' ? 'default' : 'warning',
          activeStyle:
            displayThinkingLevel === 'max'
              ? MAX_THINKING_ACTIVE_STYLE
              : undefined,
          title: 'Effort',
          ariaLabel: 'Cycle thinking level',
          icon: <ThinkingIcon />,
          label: thinkingLabel,
          dataTestId: 'chat-composer-thinking',
        }
      : undefined;

  return (
    <div ref={hintRootRef} className="border-t p-2" data-testid="chat-composer">
      {/* The composer's tip, as every host draws it. This plain box has no
          elevated surface for a top drawer to tuck under, so the tip's row
          sits on it directly. */}
      {hint.visible ? (
        <div className="mb-1">
          <PlanModeHint hint={hint} />
        </div>
      ) : null}
      <div className="relative">
        {/* The menus self-position (absolute bottom-full … mb-1), so they are
            rendered directly in this relative container — no wrapper — and are
            mutually exclusive: the @-mention menu wins when both would open. */}
        {fileEnabled && fileTypeahead.isOpen && (
          <FileTypeaheadMenu
            files={fileTypeahead.filteredFiles}
            selectedIndex={fileTypeahead.selectedIndex}
            isMultiRepo={fileTypeaheadMultiRepo}
            isLoading={fileTypeaheadLoading}
            onSelect={fileTypeahead.selectFile}
          />
        )}
        {slashEnabled && slash.isOpen && !fileTypeahead.isOpen && (
          <SlashCommandMenu
            commands={slash.filteredCommands}
            selectedIndex={slash.selectedIndex}
            onHover={slash.setSelectedIndex}
            isDiscovering={slash.isDiscovering}
            itemLabel="command"
            title="Commands"
            onSelect={slash.selectCommand}
            onRefresh={onRefreshSlashCommands}
            hiddenCount={slash.hiddenCount}
            totalCount={slash.totalCount}
            onShowAll={slash.showAll}
          />
        )}
        <SlateEditor
          key={editorKey}
          editor={editor}
          value={value}
          placeholder={resolvedPlaceholder}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          readOnly={disabled}
          containerClassName={CONTAINER_CLASS}
          editableClassName={EDITABLE_CLASS}
          dataTestId="chat-composer-input"
        />
      </div>
      <div className="mt-1">
        <ChatComposerToolbar
          planMode={planChip}
          thinking={thinkingChip}
          trailingSlot={
            isStreaming ? (
              <Button
                variant="ghost-destructive"
                size="compact"
                onClick={onStop}
                disabled={onStop === undefined}
                data-testid="chat-composer-stop"
              >
                Stop
              </Button>
            ) : (
              <Button
                variant="primary"
                size="compact"
                onClick={send}
                disabled={!canSend}
                data-testid="chat-composer-send"
              >
                Send
              </Button>
            )
          }
        />
      </div>
    </div>
  );
}
