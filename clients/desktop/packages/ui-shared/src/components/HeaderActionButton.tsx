import {
  createContext,
  forwardRef,
  useContext,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import { Tooltip } from './Tooltip';

export type HeaderActionButtonTone =
  | 'accent'
  | 'neutral'
  | 'warning'
  | 'destructive';

interface HeaderActionButtonBaseProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Semantic foreground and hover treatment; geometry stays unchanged. */
  tone?: HeaderActionButtonTone;
  /**
   * Keep the hover surface while the enclosing `group/gitaction` is hovered.
   * While an action runs, its cancel ✕ is an overlay inside the group but
   * outside the pill, so without this the pill would drop its hover state the
   * moment the pointer reaches the ✕.
   */
  groupHover?: boolean;
  /**
   * Fade to 80% while disabled instead of only dropping pointer interaction,
   * for a control that stays in place while its action runs (Refresh).
   */
  quietWhenDisabled?: boolean;
  /**
   * How pressed and disabled states read. `default` keeps the established
   * look. `toolbar` (the early-access browser address bar) gives a pressed
   * neutral toggle the hover surface and primary ink, dims a disabled
   * control to the disabled ink, and drops a disabled icon control's name
   * tooltip; an explicit `tooltipLabel` or `title` still shows.
   */
  stateStyle?: HeaderActionButtonStateStyle;
  /**
   * Rich tooltip content. Defaults to `title`, then (icon-only controls) the
   * `aria-label`; labeled controls with neither render no tooltip.
   */
  tooltipLabel?: ReactNode;
}

export type HeaderActionButtonProps = HeaderActionButtonBaseProps &
  (
    | {
        /** Render a square icon-only action. */
        iconOnly: true;
        /** Accessible name required for icon-only controls. */
        'aria-label': string;
      }
    | {
        iconOnly?: false;
      }
  );

export type HeaderActionButtonStateStyle = 'default' | 'toolbar';

/**
 * The tone a header action takes when its caller names none. A surface
 * whose rows are neutral (the Activity card) sets `neutral`, so the section
 * controls it hosts (refresh, review, settings) match it; everywhere else
 * keeps the established accent.
 */
export const HeaderActionDefaultToneContext =
  createContext<HeaderActionButtonTone>('accent');

const BASE_CLASS_NAME =
  "electron-no-drag focus-ring relative inline-flex h-7 shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-xs font-normal transition-[opacity,transform,scale] duration-150 before:absolute before:inset-x-0 before:content-[''] active:scale-97 disabled:pointer-events-none";

const TONE_CLASS_NAMES: Record<HeaderActionButtonTone, string> = {
  accent: 'bg-transparent fg-accent enabled:hover:bg-accent-subtle',
  neutral:
    'bg-transparent fg-secondary enabled:hover:bg-subtle enabled:hover:fg-primary',
  warning: 'bg-transparent fg-warning enabled:hover:bg-warning-subtle',
  /** Irreversible or trash-bound actions (Delete permanently, Empty trash). */
  destructive:
    'bg-transparent fg-destructive enabled:hover:bg-destructive-subtle',
};

const GROUP_HOVER_CLASS_NAMES: Record<HeaderActionButtonTone, string> = {
  accent: 'enabled:group-hover/gitaction:bg-accent-subtle',
  neutral: 'enabled:group-hover/gitaction:bg-subtle',
  warning: 'enabled:group-hover/gitaction:bg-warning-subtle',
  destructive: 'enabled:group-hover/gitaction:bg-destructive-subtle',
};

/** `toolbar` state classes; a pressed toggle keeps its hover look. */
const TOOLBAR_PRESSED_CLASS_NAMES: Record<HeaderActionButtonTone, string> = {
  accent: '',
  neutral: 'aria-pressed:bg-subtle aria-pressed:fg-primary',
  warning: '',
  destructive: '',
};

const LABEL_CLASS_NAME = 'px-2.5 pointer-coarse:before:-inset-y-2';
const ICON_ONLY_CLASS_NAME =
  'w-7 px-0 pointer-coarse:before:-inset-x-2 pointer-coarse:before:-inset-y-2';

/**
 * Compact action primitive shared by worktree headers and activity-card
 * controls. Its geometry is the established Create PR button shell.
 */
export const HeaderActionButton = forwardRef<
  HTMLButtonElement,
  HeaderActionButtonProps
>(function HeaderActionButton(
  {
    tone: toneProp,
    groupHover = false,
    quietWhenDisabled = false,
    stateStyle = 'default',
    iconOnly = false,
    type = 'button',
    className = '',
    tooltipLabel,
    title,
    'aria-label': ariaLabel,
    ...props
  },
  ref,
): JSX.Element {
  const defaultTone = useContext(HeaderActionDefaultToneContext);
  const tone = toneProp ?? defaultTone;
  const toolbarStates = stateStyle === 'toolbar';
  const pressedClassName = toolbarStates
    ? TOOLBAR_PRESSED_CLASS_NAMES[tone]
    : '';
  const disabledClassName = quietWhenDisabled
    ? ' disabled:opacity-80'
    : toolbarStates
      ? ' disabled:fg-disabled'
      : '';
  // `title` feeds the shared rich tooltip only — never the DOM: a native
  // title lags on macOS and would stack a second tooltip on the same control.
  const control = (
    <button
      ref={ref}
      type={type}
      data-header-action-button="true"
      aria-label={ariaLabel}
      className={`${BASE_CLASS_NAME} ${TONE_CLASS_NAMES[tone]}${pressedClassName ? ` ${pressedClassName}` : ''}${groupHover ? ` ${GROUP_HOVER_CLASS_NAMES[tone]}` : ''}${disabledClassName} ${iconOnly ? ICON_ONLY_CLASS_NAME : LABEL_CLASS_NAME} ${className}`}
      {...props}
    />
  );

  // In the toolbar style a disabled icon control has nothing to explain by
  // name, so it shows no name tooltip.
  const showsNameTooltip =
    iconOnly && !(toolbarStates && props.disabled === true);
  const label =
    tooltipLabel ?? title ?? (showsNameTooltip ? ariaLabel : undefined);
  if (label === undefined) return control;

  return <Tooltip label={label}>{control}</Tooltip>;
});

HeaderActionButton.displayName = 'HeaderActionButton';
