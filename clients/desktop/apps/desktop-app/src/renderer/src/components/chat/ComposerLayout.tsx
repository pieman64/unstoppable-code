import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  ChatComposerToolbarChip,
  type ChatComposerToolbarChipConfig,
} from '@canopy/ui-shared';
import type { ComposerDensity } from '@canopy/ui-rich/editor';
import {
  AutoIcon,
  ChatIcon,
  FastModeIcon,
  PlanModeIcon,
  PluginsIcon,
  QuestionMarkIcon,
  ScheduleIcon,
  TerminalBorderedIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import type { ChatInterfaceMode } from '@canopy/desktop-shared/types';
import type { ComposerPlusMenuItem } from '@/components/shared/ComposerPlusMenu';
import {
  CHAT_INTERFACE_MODE_DESCRIPTIONS,
  CHAT_INTERFACE_MODE_NAMES,
  type ChatInterfaceModeOption,
} from './chatInterfaceModes';
import type { ComposerMenuController } from '@/hooks/useComposerMenu';
import type { ComposerAction } from '@/lib/composerCommands';

/**
 * Classes for the one-line composer. On one line the box is a flex row and
 * the toolbar steps aside (`ChatComposerToolbar inline`), so the leading +,
 * the rail, the editor and the trailing cluster are ordered 1–4 in it.
 */
export const ONE_LINE_COMPOSER_CLASS_NAMES = {
  /**
   * Added to the composer shell while it is on one line. Items sit on the
   * bottom edge (every item is 32px tall, so at rest this is the same as
   * centring): while the box shrinks from the full layout, + and send stay
   * put instead of sliding down through the taller box.
   */
  box: 'flex items-end gap-2 p-2',
  /**
   * Added to the composer shell in the full layout. Content stacks from the
   * bottom edge: while the box grows out of the capsule, the toolbar row
   * holds + and send where the capsule had them and the text is revealed
   * above, instead of the toolbar being clipped away and dropping back in.
   */
  expandedBox: 'flex flex-col justify-end',
  /** The editor's outer box: the stretching third item of the row. */
  editor: 'order-3 min-w-0 flex-1',
  /**
   * The editor's scroll container: one 20px text line centred in the 32px
   * control height, clipped rather than scrolled (a second line opens the
   * full layout). The placeholder stays on that line and ends in an ellipsis
   * when the capsule is too narrow, instead of wrapping into a clipped half
   * line.
   */
  editorContainer:
    'max-h-8 min-h-8 cursor-text overflow-hidden px-1 py-1.5 [&_[data-slate-placeholder]]:truncate',
  /** The leading + slot: first item of the row. */
  leading: 'order-1',
} as const;

/**
 * The expanded editor sizes to its text, as the one-line composer grows: no
 * reserved empty lines, only a cap that keeps a short panel's transcript in
 * view (the density step still picks the cap from the panel height).
 */
const EXPANDED_EDITOR_MAX_HEIGHT_CLASS_NAMES: Record<ComposerDensity, string> =
  {
    comfortable: 'max-h-50',
    cozy: 'max-h-40',
    compact: 'max-h-30',
    minimal: 'max-h-16',
  };

// Terminal mode's shell edge and label live in `@canopy/ui-shared` so every
// composer host draws the same mode; re-exported for the existing imports.
export {
  TERMINAL_MODE_ERROR_SHELL_CLASS,
  TERMINAL_MODE_SHELL_CLASS,
  TerminalModeLabel,
} from '@canopy/ui-shared';

/**
 * While dictating, the text area holds two lines (two 20px lines plus its 14px
 * top and 4px bottom padding), so the box stays put while recording and when
 * the take's words are inserted as it ends.
 */
export const VOICE_TAKE_EDITOR_CONTAINER_CLASS =
  'min-h-[calc(2*var(--text-s--line-height)+1.125rem)]';

export function expandedComposerEditorContainerClassName(
  density: ComposerDensity,
): string {
  return `${EXPANDED_EDITOR_MAX_HEIGHT_CLASS_NAMES[density]} cursor-text overflow-y-auto px-4 pt-3.5 pb-1`;
}

/**
 * The one-line box is a capsule: its corner radius is half its 48px height
 * (8px padding around the 32px controls), so the ends are full semicircles.
 */
export const ONE_LINE_COMPOSER_BOX_STYLE: CSSProperties = {
  borderRadius: 24,
};

const COMPOSER_RESIZE_DURATION_MS = 200;
// Decelerate into the new size (DESIGN.md: entering motion decelerates).
const COMPOSER_RESIZE_EASING = 'cubic-bezier(0.2, 0, 0, 1)';

/**
 * Eases the composer box between the one-line capsule and the full layout,
 * both ways. Growth or shrinking within the full layout (a third line and
 * beyond) is instant, so typing never waits on the box; the corner radius,
 * which only changes between the two layouts, tells the cases apart.
 * The box's own layout already changed when this runs (a ResizeObserver
 * callback fires after layout and before paint), so the animation starts
 * from the previous height and corner radius and settles on the new ones.
 * A change that lands mid-resize is picked up when it finishes. Reduced
 * motion skips it. `resetKey` re-attaches when the host remounts the box.
 */
export function useAnimatedComposerBox(
  boxRef: RefObject<HTMLElement | null>,
  resetKey?: unknown,
): void {
  const lastRef = useRef<{ height: number; radius: string } | null>(null);
  const animationRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return undefined;
    const view = box.ownerDocument.defaultView;
    const reducedMotion =
      view?.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;

    const measure = (): { height: number; radius: string } => ({
      height: box.getBoundingClientRect().height,
      radius: getComputedStyle(box).borderTopLeftRadius,
    });

    lastRef.current = measure();
    const observer = new ResizeObserver(() => {
      // A running resize reports its own in-between heights; ignore them.
      if (animationRef.current?.playState === 'running') return;
      const previous = lastRef.current;
      const next = measure();
      lastRef.current = next;
      if (
        previous === null ||
        Math.abs(previous.height - next.height) < 1 ||
        previous.radius === next.radius ||
        reducedMotion?.matches === true ||
        typeof box.animate !== 'function'
      ) {
        return;
      }
      const animation = box.animate(
        [
          {
            height: `${previous.height}px`,
            borderRadius: previous.radius,
            overflow: 'hidden',
          },
          {
            height: `${next.height}px`,
            borderRadius: next.radius,
            overflow: 'hidden',
          },
        ],
        {
          duration: COMPOSER_RESIZE_DURATION_MS,
          easing: COMPOSER_RESIZE_EASING,
        },
      );
      animationRef.current = animation;
      animation.onfinish = (): void => {
        animationRef.current = null;
        // Content may have changed while the resize ran; settle on it.
        lastRef.current = measure();
      };
    });
    observer.observe(box);
    return (): void => {
      observer.disconnect();
      animationRef.current?.cancel();
      animationRef.current = null;
    };
  }, [boxRef, resetKey]);
}

export interface UseOneLineComposerOptions {
  /** The composer shell; its editable is measured for a second line. */
  boxRef: RefObject<HTMLElement | null>;
  /** Whether the draft has any text. An empty draft always returns to one line. */
  hasDraftText: boolean;
  /**
   * Whether the box holds only the editor and its controls. Attachments,
   * selections, notices and similar content need the full layout.
   */
  allowed: boolean;
  /** Changes whenever the draft changes, so the wrap check runs again. */
  draftRevision: unknown;
  /**
   * The least room the text keeps beside the chips and labels that share its
   * line (Plan, a scheduled send, watchers, the terminal mode label). When
   * they leave less, the box takes two rows: text on top, chips under it.
   * Omit to keep the one line whatever the room.
   */
  minTextWidth?: number;
  /**
   * Changes whenever those chips and labels change, so a box that went to
   * two rows for them tries the one line again.
   */
  sideContentKey?: string;
}

/** Room kept free in the one-line slot before the draft may return to it. */
const ONE_LINE_RETURN_SLACK_PX = 8;

/**
 * How much wider a box that went to two rows for its chips must grow before
 * it tries the one line again, so a resize does not flip it back and forth.
 */
const CRAMPED_RETURN_SLACK_PX = 24;

/** The text's least room beside the chips on the chat composer's one line. */
export const CHAT_COMPOSER_MIN_TEXT_WIDTH_PX = 160;

/**
 * Whether the editable holds one paragraph that renders on one line, and how
 * wide that line is. Slate renders each paragraph as a block child, so a
 * hard line break is a second child; a soft wrap is a second line box.
 */
function measureSingleLine(editable: HTMLElement): number | null {
  if (editable.children.length !== 1) return null;
  const block = editable.firstElementChild;
  if (!block) return null;
  const range = editable.ownerDocument.createRange();
  range.selectNodeContents(block);
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0,
  );
  if (rects.length === 0) return 0;
  const top = rects[0]?.top ?? 0;
  if (rects.some((rect) => Math.abs(rect.top - top) > 2)) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const right = Math.max(...rects.map((rect) => rect.right));
  return right - left;
}

/**
 * One line by default: +, the text and send share a row. The composer opens
 * to the full layout once the draft needs a second line, and returns to one
 * line once the draft fits the one-line text slot again. The slot is
 * narrower than the full editor, so its width is remembered while inline and
 * the draft must fit it with room to spare; text that only fits the wider
 * editor keeps the full layout instead of flipping back and forth.
 */
export function useOneLineComposer({
  boxRef,
  hasDraftText,
  allowed,
  draftRevision,
  minTextWidth,
  sideContentKey,
}: UseOneLineComposerOptions): boolean {
  const [expanded, setExpanded] = useState(false);
  // The chips beside the text left it too little room.
  const [cramped, setCramped] = useState(false);
  const crampedAtWidthRef = useRef<number | null>(null);
  const inline = allowed && !expanded && !cramped;
  const inlineSlotWidthRef = useRef<number | null>(null);

  // Other chips: try the one line again (the check below re-measures).
  useLayoutEffect(() => {
    crampedAtWidthRef.current = null;
    setCramped(false);
  }, [sideContentKey]);

  useLayoutEffect(() => {
    if (minTextWidth === undefined || !allowed || expanded) return undefined;
    const box = boxRef.current;
    const editable = box?.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    );
    if (!box || !editable) return undefined;
    const check = (): void => {
      if (!cramped) {
        // Chips can squeeze the text to nothing, so only an unlaid-out box
        // (no width yet) is skipped, not an empty text slot.
        if (box.clientWidth === 0) return;
        if (editable.clientWidth < minTextWidth) {
          crampedAtWidthRef.current = box.clientWidth;
          setCramped(true);
        }
        return;
      }
      const at = crampedAtWidthRef.current;
      if (at !== null && box.clientWidth >= at + CRAMPED_RETURN_SLACK_PX) {
        crampedAtWidthRef.current = null;
        setCramped(false);
      }
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(box);
    observer.observe(editable);
    return (): void => observer.disconnect();
  }, [boxRef, minTextWidth, allowed, expanded, cramped, sideContentKey]);

  useLayoutEffect(() => {
    if (!hasDraftText) {
      setExpanded(false);
      return undefined;
    }
    const editable = boxRef.current?.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    );
    if (!editable) return undefined;
    const check = (): void => {
      if (inline) {
        inlineSlotWidthRef.current = editable.clientWidth;
        const lineHeight = Number.parseFloat(
          getComputedStyle(editable).lineHeight,
        );
        if (editable.scrollHeight > lineHeight * 1.5) setExpanded(true);
        return;
      }
      if (!allowed) return;
      const slot = inlineSlotWidthRef.current;
      const width = measureSingleLine(editable);
      if (
        slot !== null &&
        width !== null &&
        width <= slot - ONE_LINE_RETURN_SLACK_PX
      ) {
        setExpanded(false);
      }
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(editable);
    return (): void => observer.disconnect();
  }, [boxRef, hasDraftText, inline, allowed, draftRevision]);

  return inline;
}

/**
 * Whether the row's content needs more room than it has. The trailing group
 * packs against the right edge, so when it is too narrow its content spills
 * off its LEFT side, which `scrollWidth` does not count; measure the group's
 * items against its width instead.
 */
function statusRowOverflows(row: HTMLElement): boolean {
  if (row.scrollWidth - row.clientWidth > 1) return true;
  const group = row.querySelector<HTMLElement>('[data-status-row-fill]');
  if (!group) return false;
  const items = Array.from(group.children);
  const gap = Number.parseFloat(getComputedStyle(group).columnGap) || 0;
  const needed =
    items.reduce(
      (total, item) => total + item.getBoundingClientRect().width,
      0,
    ) +
    gap * Math.max(0, items.length - 1);
  return needed - group.clientWidth > 1;
}

/** Below this box width the chips beside + draw small (icons, a time). */
export const COMPACT_CHIPS_BREAKPOINT_REM = 30;
/** Width a compact box must regain past the breakpoint before chips grow. */
export const COMPACT_CHIPS_HYSTERESIS_REM = 4;

/**
 * Whether the chips beside + should draw small in `element`'s box, with the
 * chat composer's breakpoint and hysteresis. Follows resizes and UI scale.
 * Pass the element through state (a callback ref) so a remount re-measures.
 */
export function useComposerChipsCompact(element: HTMLElement | null): boolean {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const update = (width: number): void => {
      if (width <= 0) return;
      const rootFontSize = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const breakpoint = COMPACT_CHIPS_BREAKPOINT_REM * rootFontSize;
      const hysteresis = COMPACT_CHIPS_HYSTERESIS_REM * rootFontSize;
      setCompact((prev) =>
        prev ? width < breakpoint + hysteresis : width < breakpoint,
      );
    };
    const measure = (): void => update(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const scaleObserver = new MutationObserver(measure);
    scaleObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ui-scale'],
    });
    return (): void => {
      observer.disconnect();
      scaleObserver.disconnect();
    };
  }, [element]);
  return compact;
}

/** Width the row must regain past where it overflowed before labels return. */
const STATUS_ROW_EXPAND_SLACK_PX = 24;

/**
 * Whether the status row's selectors should drop their labels. They keep
 * them until the row actually runs out of room (its content overflows), and
 * get them back once the row is wider than where that happened by a margin,
 * so it never flickers at the boundary. Hosts keep the model name at full
 * width until the row is compact, so compacting the other selectors comes
 * first and the model name is the last thing to give way.
 */
export function useStatusRowCompact(
  rowRef: RefObject<HTMLElement | null>,
): boolean {
  const [compact, setCompact] = useState(false);
  const compactedAtRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return undefined;
    const check = (): void => {
      const width = row.clientWidth;
      if (width <= 0) return;
      const compactedAt = compactedAtRef.current;
      if (compactedAt === null) {
        if (statusRowOverflows(row)) {
          compactedAtRef.current = width;
          setCompact(true);
        }
        return;
      }
      if (width >= compactedAt + STATUS_ROW_EXPAND_SLACK_PX) {
        compactedAtRef.current = null;
        setCompact(false);
      }
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(row);
    return (): void => observer.disconnect();
  }, [rowRef, compact]);

  return compact;
}

export interface ComposerStatusRowProps {
  /** Leading settings: the permission level. */
  start: ReactNode;
  /** Trailing settings: model, effort and context usage. */
  end: ReactNode;
  /**
   * The side that takes the row's free width: `end` (the default) packs its
   * selectors against the right edge; `start` packs the leading ones against
   * the left, and the trailing ones hold their width.
   */
  fill?: 'start' | 'end';
  /** The row element, for `useStatusRowCompact`. */
  rowRef?: RefObject<HTMLDivElement | null>;
}

/**
 * The session settings under the composer box. Kept outside the box so the
 * input stays focused on the message itself, and so every setting stays
 * visible at every composer width.
 */
export function ComposerStatusRow({
  start,
  end,
  fill = 'end',
  rowRef,
}: ComposerStatusRowProps): JSX.Element {
  if (fill === 'start') {
    return (
      <div
        ref={rowRef}
        data-testid="chat-composer-status-row"
        className="flex min-w-0 select-none items-center justify-between gap-2 pt-2 pl-1.5 pr-2"
      >
        {/* Fills the rest of the row, so its selectors truncate when space
            runs out rather than pushing the trailing group off the row. */}
        <div
          data-status-row-fill
          data-fit-container
          className="flex min-w-0 flex-1 items-center justify-start gap-0"
        >
          {start}
        </div>
        <div className="flex shrink-0 items-center gap-1">{end}</div>
      </div>
    );
  }
  return (
    // Insets line the row's first and last glyphs up with the composer's:
    // the permission shield under the + glyph, the context ring centred under
    // the send glyph (each control carries its own padding inside these).
    <div
      ref={rowRef}
      data-testid="chat-composer-status-row"
      // Controls, not copy: a drag across the row must not select labels.
      className="flex min-w-0 select-none items-center justify-between gap-2 pt-2 pl-1.5 pr-2"
    >
      <div className="shrink-0">{start}</div>
      {/* Fills the rest of the row and packs its selectors against the
          right edge, so they hold their positions whatever the permission
          label's width; the model name gives way when space runs out. */}
      <div
        data-status-row-fill
        data-fit-container
        // No gap: the controls sit edge to edge, their own padding spacing
        // the labels and glyphs.
        className="flex min-w-0 flex-1 items-center justify-end gap-0"
      >
        {end}
      </div>
    </div>
  );
}

export interface ChatComposerPlusItemsOptions {
  onOpenPlugins: () => void;
  hasPluginSelections: boolean;
  /** Plan mode, when the chat's harness supports it. */
  plan?: {
    on: boolean;
    /** Cursor calls it read-only mode. */
    readOnly: boolean;
    disabled: boolean;
    onToggle: () => void;
  };
  /** Opens the schedule dialog, when scheduled sends are available. */
  onSchedule?: () => void;
  /**
   * A Claude chat's interface modes, as exclusive choices under View: the
   * app's chat, Auto, or the Claude Code terminal.
   */
  interfaceModes?: {
    options: readonly ChatInterfaceModeOption[];
    onSelect: (mode: ChatInterfaceMode) => void;
  };
}

const CHAT_INTERFACE_MODE_ICONS: Record<ChatInterfaceMode, JSX.Element> = {
  canopy: <ChatIcon width={16} height={16} />,
  auto: <AutoIcon width={16} height={16} />,
  'claude-code': <TerminalBorderedIcon width={16} height={16} />,
};

/** The chat composer's own rows in the + menu, after the attachment rows. */
export function buildChatComposerPlusItems({
  onOpenPlugins,
  hasPluginSelections,
  plan,
  onSchedule,
  interfaceModes,
}: ChatComposerPlusItemsOptions): ComposerPlusMenuItem[] {
  const items: ComposerPlusMenuItem[] = [
    {
      id: 'plugins',
      label: 'Plugins',
      icon: <PluginsIcon width={16} height={16} />,
      onSelect: onOpenPlugins,
      ariaChecked: hasPluginSelections,
      dataTestId: 'chat-plugins-button',
    },
  ];
  if (plan) {
    items.push({
      id: 'plan-mode',
      label: plan.readOnly ? 'Read-only mode' : 'Plan mode',
      description: plan.on ? 'Turn off' : 'Turn on',
      value: plan.on ? 'On' : undefined,
      icon: <PlanModeIcon width={16} height={16} active={plan.on} />,
      onSelect: plan.onToggle,
      disabled: plan.disabled,
      selected: false,
      ariaChecked: plan.on,
      dataTestId: 'chat-input-plan-mode-button',
    });
  }
  if (onSchedule) {
    items.push({
      id: 'schedule',
      label: 'Schedule message',
      icon: <ScheduleIcon width={16} height={16} />,
      onSelect: onSchedule,
      dataTestId: 'chat-input-schedule-button',
    });
  }
  for (const option of interfaceModes?.options ?? []) {
    const name = CHAT_INTERFACE_MODE_NAMES[option.mode];
    items.push({
      id: `interface-mode-${option.mode}`,
      group: 'view',
      label: name,
      description: CHAT_INTERFACE_MODE_DESCRIPTIONS[option.mode],
      icon: CHAT_INTERFACE_MODE_ICONS[option.mode],
      onSelect: (): void => {
        if (!option.active) interfaceModes?.onSelect(option.mode);
      },
      disabled: option.disabled,
      ...(option.busyReason
        ? { disabledTooltip: { title: name, description: option.busyReason } }
        : {}),
      checked: option.active,
      ariaChecked: option.active,
      dataTestId: `chat-interface-mode-option-${option.mode}`,
    });
  }
  return items;
}

/**
 * Plan's chip once the plan-approval prompt is closed while the plan still
 * waits: it names the state and reopens the prompt. Approving, running it as
 * a pipeline, or telling the agent what to change all happen there.
 */
export function buildPlanReadyChip({
  onOpen,
  compact = false,
}: {
  onOpen: () => void;
  compact?: boolean;
}): ChatComposerToolbarChipConfig {
  return {
    onClick: onOpen,
    active: true,
    activeTone: 'warning',
    ariaLabel: 'Plan ready, review it',
    title: 'Review the plan',
    icon: <PlanModeIcon width={16} height={16} active />,
    ...(compact ? {} : { label: 'Plan ready' }),
    variant: 'capsule',
    dataTestId: 'chat-input-plan-ready-chip',
  };
}

/**
 * The chip beside + while a question waits with its prompt closed: it reads
 * "Question" and reopens the prompt, as "Plan ready" does for a plan.
 */
export function buildQuestionReadyChip({
  onOpen,
  compact = false,
}: {
  onOpen: () => void;
  compact?: boolean;
}): ChatComposerToolbarChipConfig {
  return {
    onClick: onOpen,
    active: true,
    activeTone: 'warning',
    ariaLabel: 'Question waiting, answer it',
    title: 'Answer the question',
    icon: <QuestionMarkIcon width={16} height={16} />,
    ...(compact ? {} : { label: 'Question' }),
    variant: 'capsule',
    dataTestId: 'chat-input-question-ready-chip',
  };
}

/** What each composer action does in a given host; unsupported ones are absent. */
export type ComposerActionHandlers = Partial<
  Record<ComposerAction, () => void>
>;

/**
 * Runs a composer action picked from the / or + menu. `help` and
 * `commands` reopen the menu on the full command list; every other action
 * clears the typed trigger, syncs the draft, and runs the host's handler.
 * An action this host cannot perform reports back instead of doing nothing.
 */
export function runComposerAction(
  action: ComposerAction,
  {
    controller,
    handlers,
    syncDraft,
    onUnavailable,
  }: {
    controller: ComposerMenuController;
    handlers: ComposerActionHandlers;
    syncDraft: () => void;
    onUnavailable: () => void;
  },
): void {
  if (action === 'help' || action === 'commands') {
    controller.consumeTrigger();
    controller.onOpenChange(true);
    syncDraft();
    return;
  }
  const handler = handlers[action];
  if (!handler) {
    onUnavailable();
    return;
  }
  controller.consumeTrigger();
  syncDraft();
  handler();
}

/**
 * The fast-mode toggle in the settings row under the composer, beside
 * effort, for models that offer it. The label names the on state only (like
 * the Plan chip) and drops away in a compact row.
 */
export function buildFastModeChip({
  on,
  disabled,
  compact,
  onToggle,
}: {
  on: boolean;
  disabled: boolean;
  compact: boolean;
  onToggle: () => void;
}): ChatComposerToolbarChipConfig {
  return {
    onClick: onToggle,
    disabled,
    active: on,
    ariaPressed: on,
    activeStyle: {
      backgroundColor: 'var(--codex-fast-mode-background)',
      color: 'var(--codex-fast-mode-foreground)',
    },
    ariaLabel: 'Toggle fast mode',
    title: 'Fast mode consumes 2x usage.',
    tooltipDelay: 'long',
    icon: (
      // The bolt spans almost its whole 24 grid, so at 16px it stood about
      // 1px taller than the effort glyph beside it, and at 14px it read too
      // small (it is narrow). 15px in the same 16px slot splits the
      // difference; the stroke scales up by 16/15 to keep the composer's
      // rendered weight.
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
        <FastModeIcon size={15} active={on} />
      </span>
    ),
    // The label folds in and out with the toggle, and away in compact rows.
    label: 'Fast',
    labelCollapsed: !on || compact,
    variant: 'capsule',
    dataTestId: 'chat-input-fast-mode-button',
  };
}

/** The status row's fast mode toggle; its label folds in when turned on. */
export function FastModeChip(props: {
  on: boolean;
  disabled: boolean;
  compact: boolean;
  onToggle: () => void;
}): JSX.Element {
  return <ChatComposerToolbarChip {...buildFastModeChip(props)} />;
}
