import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type JSX,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { RowActionTray } from './RowActions';
import {
  SIDEBAR_ITEM_IDLE_CLASSNAME,
  SIDEBAR_ITEM_SELECTED_CLASSNAME,
} from './sidebar-item-classes';

/** 28px for compact activity rows, 32px by default, 40px for logos and pickers. */
export type ListRowSize = 'sm' | 'md' | 'lg';

/** The slots every row form shares. */
interface ListRowContentProps {
  /** The row's label. */
  readonly children: ReactNode;
  /** One line of secondary text under the label; the row grows to hold it. */
  readonly description?: ReactNode;
  /**
   * A glyph before the label: 14px at `sm`, 16px at `md`, 20px at `lg`. At
   * `lg` the slot grows for a larger logo.
   */
  readonly icon?: ReactNode;
  /** Quiet content at the end of the row: a time, a count, a chevron. */
  readonly trailing?: ReactNode;
  /**
   * The row the user is on; takes the selected fill instead of the hover.
   * Visual only: pass `aria-current` or `aria-selected` for what it means.
   */
  readonly selected?: boolean;
  /** The row's height. A description grows the row at every size. */
  readonly size?: ListRowSize;
  /**
   * Controls beside the row's main press, rendered as its siblings because a
   * control inside a `<button>` is invalid HTML. `trailing` stays quiet text.
   */
  readonly actions?: ReactNode;
  /**
   * Hide `actions` until the row is hovered or holds focus; on touch they
   * always show. `sm` and `md` reveal, `lg` keeps them visible. Pass `false`
   * to keep replacement controls up, like an inline delete confirmation,
   * after the trigger that opened them unmounts.
   */
  readonly actionsReveal?: boolean;
}

/** What a row's wrapper takes: test ids, dnd-kit attributes, hover handlers. */
export type ListRowRootProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'className'
> &
  Readonly<Record<`data-${string}`, string | number | boolean | undefined>>;

export interface ListRowProps
  extends
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>,
    ListRowContentProps {
  /**
   * Attributes for the wrapper around the main press. Setting this, like
   * `actions`, gives the row its wrapper. The other props stay on the press.
   */
  readonly rowProps?: ListRowRootProps;
}

/** The anchor a host renders for a `ListRowLink`, such as its router's link. */
export type ListRowLinkRenderProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  readonly href: string;
  readonly children: ReactNode;
};

export interface ListRowLinkProps
  extends
    Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children' | 'href'>,
    ListRowContentProps {
  readonly href: string;
  /** A disabled link keeps its look, loses its `href` and swallows clicks. */
  readonly disabled?: boolean;
  /**
   * Handles a plain left click in place, such as navigating inside the app.
   * Cmd, Ctrl, Shift, Alt and middle clicks stay the browser's own.
   */
  readonly onNavigate?: (event: MouseEvent<HTMLAnchorElement>) => void;
  /**
   * Renders the anchor through the host's router; defaults to a plain `<a>`.
   * The row's `ref` reaches a plain `<a>` only.
   */
  readonly renderLink?: (props: ListRowLinkRenderProps) => ReactNode;
  /** Attributes for the wrapper `actions` adds. */
  readonly rowProps?: ListRowRootProps;
}

export interface ListRowStaticProps
  extends
    Omit<HTMLAttributes<HTMLDivElement>, 'children'>,
    ListRowContentProps {
  /** Greys the row's text. Its `actions` keep their own state. */
  readonly disabled?: boolean;
}

// The sidebar row's geometry (`SIDEBAR_LIST_ITEM_CLASSNAME`: row radius, 8px
// inset, 8px gap) for rows in page and panel content, so every list in the app
// shares one row. Touch keeps a 44px floor at every size.
//
// A disabled row greys its label, description, icon and trailing text
// together; the inner parts read `data-disabled` through the row's group, which
// works on all three elements a row can be. A disabled row stays the click
// target (a click is swallowed, not handed to what is behind it) and drops the
// hover fill instead: `data-disabled:` sorts after `hover:`, so it wins.
const ROW_CLASS_NAME =
  'flex gap-2 overflow-hidden rounded-row px-2 text-left font-normal pointer-coarse:min-h-11 data-disabled:cursor-not-allowed data-disabled:fg-disabled';

// With `actions` the row is a wrapper holding the press and its siblings. The
// press's `::before` covers the wrapper, so the whole row presses with no
// click forwarding and modifier keys stay native; the actions sit above it.
const STRETCHED_PRESS_CLASS_NAME =
  'focus-ring focus-ring-stretched before:absolute before:inset-0 before:rounded-row';

const ROOT_CLASS_NAME = 'group group/list-row relative flex rounded-row';

const ACTIONS_CLASS_NAME =
  'relative z-10 flex shrink-0 items-center gap-0.5 self-center pr-1 pointer-coarse:gap-4';

const DISABLED_INK_CLASS_NAME = 'group-data-disabled/list-row:fg-disabled';

const IDLE_FILL_CLASS_NAME = `${SIDEBAR_ITEM_IDLE_CLASSNAME} data-disabled:bg-transparent`;

const SIZE_CLASS_NAMES: Record<
  ListRowSize,
  {
    readonly text: string;
    readonly oneLine: string;
    readonly twoLine: string;
    readonly icon: string;
    readonly description: string;
  }
> = {
  sm: {
    text: 'text-xs',
    oneLine: 'h-7 items-center whitespace-nowrap',
    twoLine: 'min-h-7 items-start py-1',
    icon: 'h-4 w-3.5',
    description: 'text-2xs',
  },
  md: {
    text: 'text-s',
    oneLine: 'h-8 items-center whitespace-nowrap',
    twoLine: 'min-h-8 items-start py-1.5',
    icon: 'h-5 w-4',
    description: 'text-xs',
  },
  lg: {
    text: 'text-s',
    oneLine: 'h-10 items-center whitespace-nowrap',
    twoLine: 'min-h-10 items-start py-1.5',
    icon: 'min-h-5 min-w-5',
    description: 'text-xs',
  },
};

function hasContent(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false;
}

function shapeClassName(size: ListRowSize, description: ReactNode): string {
  const { text, oneLine, twoLine } = SIZE_CLASS_NAMES[size];
  return `${text} ${hasContent(description) ? twoLine : oneLine}`;
}

/** A row's fill. A static row has no press, so it never takes the hover. */
function fillClassName(selected: boolean, pressable: boolean): string {
  if (selected) return SIDEBAR_ITEM_SELECTED_CLASSNAME;
  return pressable ? IDLE_FILL_CLASS_NAME : 'fg-primary';
}

function joinClassNames(...classNames: readonly string[]): string {
  return classNames.filter((className) => className !== '').join(' ');
}

/** The classes of the `<button>` or `<a>` a row presses. */
function pressClassName({
  wrapped,
  fill,
  size,
  description,
  className,
}: {
  readonly wrapped: boolean;
  readonly fill: string;
  readonly size: ListRowSize;
  readonly description: ReactNode;
  readonly className: string;
}): string {
  return joinClassNames(
    wrapped
      ? `${STRETCHED_PRESS_CLASS_NAME} min-w-0 flex-1`
      : `focus-ring group/list-row w-full ${fill}`,
    ROW_CLASS_NAME,
    shapeClassName(size, description),
    wrapped ? '' : className,
  );
}

function isPlainClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

function swallowClick(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function ListRowContent({
  children,
  description,
  icon,
  trailing,
  size,
}: {
  readonly children: ReactNode;
  readonly description: ReactNode;
  readonly icon: ReactNode;
  readonly trailing: ReactNode;
  readonly size: ListRowSize;
}): JSX.Element {
  const sizeClassNames = SIZE_CLASS_NAMES[size];
  return (
    <>
      {icon !== undefined && (
        // The sidebar's icon slot at `md`, 20px tall to match the label's line,
        // so the glyph centres on the first line in the two-line form too.
        <span
          className={`inline-flex ${sizeClassNames.icon} shrink-0 items-center justify-center fg-secondary ${DISABLED_INK_CLASS_NAME}`}
        >
          {icon}
        </span>
      )}
      {hasContent(description) ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{children}</span>
          <span
            className={`truncate ${sizeClassNames.description} fg-secondary ${DISABLED_INK_CLASS_NAME}`}
          >
            {description}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{children}</span>
      )}
      {trailing !== undefined && (
        <span
          className={`ml-auto inline-flex h-5 shrink-0 items-center text-xs fg-quaternary ${DISABLED_INK_CLASS_NAME}`}
        >
          {trailing}
        </span>
      )}
    </>
  );
}

/** The wrapper of a row with actions: holds the fill, the press and the actions. */
function ListRowRoot({
  actions,
  reveal,
  fill,
  className,
  disabled,
  rootProps,
  rootRef,
  children,
}: {
  readonly actions: ReactNode;
  readonly reveal: boolean;
  readonly fill: string;
  readonly className: string;
  readonly disabled: boolean;
  readonly rootProps?: ListRowRootProps;
  readonly rootRef?: Ref<HTMLDivElement>;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      {...rootProps}
      ref={rootRef}
      data-disabled={disabled ? '' : undefined}
      className={joinClassNames(ROOT_CLASS_NAME, fill, className)}
    >
      {children}
      {hasContent(actions) &&
        (reveal ? (
          <RowActionTray inRowOnTouch>{actions}</RowActionTray>
        ) : (
          <div className={ACTIONS_CLASS_NAME}>{actions}</div>
        ))}
    </div>
  );
}

/**
 * A full-width clickable row that opens or selects something: a pipeline step,
 * a connector, a file. Actions beside the row go in `actions` and stay
 * `Button`s; the row itself is this. A row that navigates is `ListRowLink`,
 * and a row with no main press is `ListRowStatic`.
 */
export const ListRow = forwardRef<HTMLButtonElement, ListRowProps>(
  function ListRow(
    {
      children,
      description,
      icon,
      trailing,
      selected = false,
      size = 'md',
      actions,
      actionsReveal = size !== 'lg',
      rowProps,
      className = '',
      type = 'button',
      disabled = false,
      onClick,
      ...buttonProps
    },
    ref,
  ): JSX.Element {
    // `aria-disabled` keeps the row focusable, so a keyboard reaches the reason
    // its `aria-describedby` names; the native attribute would drop it.
    const softDisabled =
      buttonProps['aria-disabled'] === true ||
      buttonProps['aria-disabled'] === 'true';
    const inactive = disabled || softDisabled;
    const wrapped = hasContent(actions) || rowProps !== undefined;
    const fill = fillClassName(selected, true);
    const press = (
      <button
        {...buttonProps}
        ref={ref}
        type={type}
        disabled={disabled}
        onClick={softDisabled ? swallowClick : onClick}
        data-disabled={inactive ? '' : undefined}
        className={pressClassName({
          wrapped,
          fill,
          size,
          description,
          className,
        })}
      >
        <ListRowContent
          description={description}
          icon={icon}
          trailing={trailing}
          size={size}
        >
          {children}
        </ListRowContent>
      </button>
    );
    if (!wrapped) return press;
    return (
      <ListRowRoot
        actions={actions}
        reveal={actionsReveal}
        fill={fill}
        className={`w-full ${className}`.trim()}
        disabled={inactive}
        rootProps={rowProps}
      >
        {press}
      </ListRowRoot>
    );
  },
);

ListRow.displayName = 'ListRow';

/**
 * `ListRow` for a row that goes somewhere: a real link, so Cmd-click and the
 * context menu work. `ui-shared` never imports a router, so a host's link comes
 * in through `renderLink`.
 */
export const ListRowLink = forwardRef<HTMLAnchorElement, ListRowLinkProps>(
  function ListRowLink(
    {
      children,
      description,
      icon,
      trailing,
      selected = false,
      size = 'md',
      actions,
      actionsReveal = size !== 'lg',
      rowProps,
      href,
      disabled = false,
      onNavigate,
      renderLink,
      onClick,
      className = '',
      ...anchorProps
    },
    ref,
  ): JSX.Element {
    const wrapped = hasContent(actions) || rowProps !== undefined;
    const fill = fillClassName(selected, true);
    const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
      onClick?.(event);
      if (
        onNavigate === undefined ||
        event.defaultPrevented ||
        !isPlainClick(event)
      ) {
        return;
      }
      event.preventDefault();
      onNavigate(event);
    };
    const linkClassName = pressClassName({
      wrapped,
      fill,
      size,
      description,
      className,
    });
    const content = (
      <ListRowContent
        description={description}
        icon={icon}
        trailing={trailing}
        size={size}
      >
        {children}
      </ListRowContent>
    );
    let link: ReactNode;
    if (disabled) {
      link = (
        <a
          {...anchorProps}
          ref={ref}
          aria-disabled="true"
          data-disabled=""
          onClick={swallowClick}
          className={linkClassName}
        >
          {content}
        </a>
      );
    } else if (renderLink !== undefined) {
      link = renderLink({
        ...anchorProps,
        href,
        onClick: handleClick,
        className: linkClassName,
        children: content,
      });
    } else {
      link = (
        <a
          {...anchorProps}
          ref={ref}
          href={href}
          onClick={handleClick}
          className={linkClassName}
        >
          {content}
        </a>
      );
    }
    if (!wrapped) return <>{link}</>;
    return (
      <ListRowRoot
        actions={actions}
        reveal={actionsReveal}
        fill={fill}
        className={`w-full ${className}`.trim()}
        disabled={disabled}
        rootProps={rowProps}
      >
        {link}
      </ListRowRoot>
    );
  },
);

ListRowLink.displayName = 'ListRowLink';

/**
 * A `ListRow` with no main press: it opens and selects nothing, so it takes no
 * hover fill. Its controls go in `actions`, and the row itself is a plain `div`
 * that takes any attribute a wrapper needs (dnd-kit, test ids).
 */
export const ListRowStatic = forwardRef<HTMLDivElement, ListRowStaticProps>(
  function ListRowStatic(
    {
      children,
      description,
      icon,
      trailing,
      selected = false,
      size = 'md',
      actions,
      actionsReveal = size !== 'lg',
      disabled = false,
      className = '',
      ...divProps
    },
    ref,
  ): JSX.Element {
    const fill = fillClassName(selected, false);
    const content = (
      <ListRowContent
        description={description}
        icon={icon}
        trailing={trailing}
        size={size}
      >
        {children}
      </ListRowContent>
    );
    if (!hasContent(actions)) {
      return (
        <div
          {...divProps}
          ref={ref}
          data-disabled={disabled ? '' : undefined}
          className={joinClassNames(
            'group/list-row w-full',
            fill,
            ROW_CLASS_NAME,
            shapeClassName(size, description),
            className,
          )}
        >
          {content}
        </div>
      );
    }
    return (
      <ListRowRoot
        actions={actions}
        reveal={actionsReveal}
        fill={fill}
        className={`w-full ${className}`.trim()}
        disabled={disabled}
        rootProps={divProps}
        rootRef={ref}
      >
        <div
          className={joinClassNames(
            'min-w-0 flex-1',
            ROW_CLASS_NAME,
            shapeClassName(size, description),
          )}
        >
          {content}
        </div>
      </ListRowRoot>
    );
  },
);

ListRowStatic.displayName = 'ListRowStatic';
