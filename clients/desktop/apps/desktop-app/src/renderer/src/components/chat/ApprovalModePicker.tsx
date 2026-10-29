import {
  memo,
  useEffect,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import { APPROVAL_MODE_MENU_LABELS } from './approval-mode-labels';
import {
  DropdownMenuItem,
  COMPOSER_ROW_MENU_GAP,
  DropdownMenuItemIcon,
  type DropdownMenuItemIconTone,
  FloatingMenu,
  FoldReveal,
  PickerTrigger,
  PickerTriggerChevron,
  Tooltip,
} from '@canopy/ui-shared';
import {
  CheckIcon,
  ApprovalAskIcon,
  ApprovalAutoIcon,
  ShieldAccessIcon,
  type AppIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  APPROVAL_MODES,
  type ApprovalMode,
} from '@canopy/desktop-shared/types';

export interface ApprovalModePickerProps {
  mode: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
  /**
   * Renders no trigger and anchors the menu elsewhere. Used when the toolbar
   * has compressed this control away and the "+" menu drives it instead, so
   * approvals stay reachable at the narrowest widths.
   */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Increment to open the menu imperatively while triggerless. */
  openSignal?: number;
  /**
   * Where focus goes when the menu closes. Required alongside
   * {@link anchorRef}: that anchor is an `aria-hidden` span with no tabindex,
   * so the default `anchorRef.current?.focus()` is a no-op and focus would
   * fall to `<body>` — Tab restarts at the top of the document. The other
   * surfaces on that same anchor all pass the "+" trigger here.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  disabled?: boolean;
  /** Hides the label text, showing only the trigger icon (mirrors the other compact rail controls). */
  compact?: boolean;
  /**
   * What a compact trigger keeps. `icon` (the Home rail) shows the glyph
   * alone; `label` (the chat composer's settings row) keeps the mode's name
   * and chevron and drops the glyph.
   */
  compactStyle?: 'icon' | 'label';
  /**
   * Leaves the mode's glyph off the trigger at every width: the label and
   * chevron alone. The menu rows keep their glyphs.
   */
  hideTriggerIcon?: boolean;
  /**
   * Lines the menu's left edge up with this element (the composer box)
   * while it still opens above the trigger.
   */
  menuAlignRef?: RefObject<HTMLElement | null>;
  /** Which edge of `menuAlignRef` the menu lines up with; `left` by default. */
  menuAlignEdge?: 'left' | 'right';
  /** Leaves the trigger's chevron off: the mode's name alone. */
  hideTriggerChevron?: boolean;
}

const APPROVAL_MODE_DESCRIPTIONS: Record<ApprovalMode, string> = {
  ask: 'Prompt before every tool call',
  auto: 'Edit project files, prompt for the rest',
  'full-access': 'Approve everything without prompting',
};

// The tooltip says what the control does while the label shows the mode; an
// icon-only rail hides the label, so there it names the mode instead.
const TOOLTIP_LABEL = 'Change permissions';
const COMPACT_TOOLTIP_PREFIX = 'Permissions';
const MENU_ID = 'approval-mode-picker-menu';

/** Same glyph size as the model and effort capsules beside it. */
const ICON_SIZE = 16;

/**
 * One glyph per mode so the composer communicates the active posture at a
 * glance instead of relying on the (hidden in compact rails) text label: a
 * raised hand stops and asks, a shield approves on your behalf, and the
 * shield with a mark approves everything.
 */
const APPROVAL_MODE_ICONS: Record<ApprovalMode, AppIcon> = {
  ask: ApprovalAskIcon,
  auto: ApprovalAutoIcon,
  'full-access': ShieldAccessIcon,
};

/**
 * Only the risky mode takes a color (DESIGN.md: color only when it means
 * something). Ask and Auto rest in the neutral secondary ink.
 */
const APPROVAL_MODE_COLOR_CLASSES: Record<ApprovalMode, string> = {
  ask: 'fg-secondary',
  auto: 'fg-secondary',
  'full-access': 'fg-destructive',
};

/** The same inks for the menu's icon slot, which takes a typed tone. */
const APPROVAL_MODE_ICON_TONES: Record<ApprovalMode, DropdownMenuItemIconTone> =
  {
    ask: 'secondary',
    auto: 'secondary',
    'full-access': 'destructive',
  };

/**
 * The current mode's shield glyph on its own, for surfaces that present
 * approvals without the picker trigger (the composer's "+" overflow menu).
 */
export interface ApprovalModeGlyphProps {
  mode: ApprovalMode;
  width: number;
  height: number;
}

export function ApprovalModeGlyph({
  mode,
  width,
  height,
}: ApprovalModeGlyphProps): JSX.Element {
  const Icon = APPROVAL_MODE_ICONS[mode];
  return (
    <span className={`inline-flex ${APPROVAL_MODE_COLOR_CLASSES[mode]}`}>
      <Icon width={width} height={height} />
    </span>
  );
}

/**
 * Composer toolbar capsule that lets the user switch a chat tab's tool-approval
 * mode (Ask/Auto/Full) without leaving the conversation. The trigger shares the
 * capsule recipe of the model and effort controls beside it; the menu is the
 * same FloatingMenu + DropdownMenuItem action menu the sidebar context menus
 * use, so every dropdown in the app reads as one component. Rows carry the
 * mode shield on the left, a label with its subtitle, and a trailing check on
 * the selected mode.
 */
export const ApprovalModePicker = memo(function ApprovalModePicker({
  mode,
  onChange,
  disabled = false,
  compact = false,
  compactStyle = 'icon',
  hideTriggerIcon = false,
  anchorRef,
  menuAlignRef,
  menuAlignEdge = 'left',
  hideTriggerChevron = false,
  openSignal,
  returnFocusRef,
}: ApprovalModePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const triggerless = anchorRef !== undefined;

  // Imperative open for the triggerless case. The mount-time value is
  // ignored so the menu never springs open on first render.
  const lastOpenSignalRef = useRef(openSignal);
  useEffect(() => {
    if (openSignal === undefined || openSignal === lastOpenSignalRef.current) {
      return;
    }
    lastOpenSignalRef.current = openSignal;
    setOpen(true);
  }, [openSignal]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  const label = APPROVAL_MODE_MENU_LABELS[mode];
  const SelectedIcon = APPROVAL_MODE_ICONS[mode];

  return (
    <div className="relative shrink-0">
      {/* Suppressed while the menu is open: the tooltip explains the closed
          control, and leaving it mounted over an open menu only occludes it. */}
      {triggerless ? null : (
        <Tooltip
          label={
            compact && compactStyle === 'icon'
              ? `${COMPACT_TOOLTIP_PREFIX}: ${label}`
              : TOOLTIP_LABEL
          }
          delay="long"
          suppressed={open}
        >
          <PickerTrigger
            ref={triggerRef}
            data-testid="approval-mode-picker"
            // No glyph on the left (hidden, or folded away in a tight row):
            // the label takes 2px more leading room.
            textLead={hideTriggerIcon || (compact && compactStyle === 'label')}
            textTrail={
              hideTriggerChevron && (!compact || compactStyle === 'label')
            }
            disabled={disabled}
            onClick={(): void => setOpen((prev) => !prev)}
            className="shrink-0"
            aria-label={`Tool approval mode, current mode ${label}`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? MENU_ID : undefined}
          >
            {compact && compactStyle === 'icon' ? (
              <span
                data-testid="approval-mode-icon"
                data-approval-mode={mode}
                className={`inline-flex shrink-0 -translate-y-[var(--border-hairline)] ${APPROVAL_MODE_COLOR_CLASSES[mode]}`}
              >
                <SelectedIcon width={ICON_SIZE} height={ICON_SIZE} />
              </span>
            ) : (
              // The glyph folds away in a label-style compact row. `pr-1.5`
              // plus the capsule's 4px gap, less the `-mr-1`, leaves 6px
              // between glyph and label (the model picker's icon inset);
              // folded, the margin takes the gap back. The node stays for
              // automation that reads the mode.
              <FoldReveal open={!compact && !hideTriggerIcon} className="-mr-1">
                <span
                  data-testid="approval-mode-icon"
                  data-approval-mode={mode}
                  // Up one device pixel (0.5px on a Retina screen): the hand
                  // and shields read low when box-centered beside the other
                  // status-row glyphs.
                  className={`inline-flex shrink-0 -translate-y-[var(--border-hairline)] pr-1.5 ${APPROVAL_MODE_COLOR_CLASSES[mode]}`}
                >
                  <SelectedIcon width={ICON_SIZE} height={ICON_SIZE} />
                </span>
              </FoldReveal>
            )}
            {(!compact || compactStyle === 'label') && (
              <>
                {/* Primary ink like the model picker's label; the shared
                    capsule recipe would otherwise paint it secondary. */}
                <span className="fg-primary">{label}</span>
                {hideTriggerChevron ? null : (
                  <PickerTriggerChevron open={open} />
                )}
              </>
            )}
          </PickerTrigger>
        </Tooltip>
      )}

      <FloatingMenu
        id={MENU_ID}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef ?? triggerRef}
        // Aligned to the composer, the menu also clears the trigger by the
        // row's 8px gap, so its bottom edge meets the composer's.
        {...(menuAlignRef
          ? { alignRef: menuAlignRef, gap: COMPOSER_ROW_MENU_GAP }
          : {})}
        returnFocusRef={returnFocusRef}
        placement={menuAlignEdge === 'right' ? 'top-right' : 'top-left'}
        aria-label="Approval mode options"
        data-canopy-browser-native-overlay="true"
        data-testid="approval-mode-menu"
        // A fixed width that fits the longest subtitle and the trailing check
        // column; the footer hint wraps inside it instead of widening the
        // menu to its full sentence.
        className="w-69"
      >
        {APPROVAL_MODES.map((option) => {
          const OptionIcon = APPROVAL_MODE_ICONS[option];
          const selected = option === mode;
          return (
            <DropdownMenuItem
              key={option}
              role="menuitemradio"
              data-testid={`approval-mode-option-${option}`}
              aria-checked={selected}
              onMouseDown={(event): void => {
                event.preventDefault();
              }}
              onClick={(): void => {
                onChange(option);
                setOpen(false);
              }}
              // Two-line row: the label carries its subtitle beneath it, and
              // the coloured shields read as a column beside the copy.
              multiline
            >
              <DropdownMenuItemIcon tone={APPROVAL_MODE_ICON_TONES[option]}>
                <OptionIcon
                  data-testid={`approval-mode-option-icon-${option}`}
                  width={ICON_SIZE}
                  height={ICON_SIZE}
                />
              </DropdownMenuItemIcon>
              {/* The label keeps its text size's own 20px line (a 16px line
                  clipped its descenders against the subtitle). Its 4px
                  margin on the row's 8px gap sets the copy 12px off the
                  mode glyph, which reads as a column of its own. */}
              <span className="ml-1 flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate">
                  {APPROVAL_MODE_MENU_LABELS[option]}
                </span>
                <span className="truncate text-2xs leading-3 fg-secondary">
                  {APPROVAL_MODE_DESCRIPTIONS[option]}
                </span>
              </span>
              {selected && (
                <span
                  aria-hidden="true"
                  data-testid={`approval-mode-option-check-${option}`}
                  className="ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center"
                >
                  <CheckIcon width={ICON_SIZE} height={ICON_SIZE} />
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
      </FloatingMenu>
    </div>
  );
});
