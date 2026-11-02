'use client';

import {
  forwardRef,
  useId,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

/**
 * Descendants that own their own keyboard or pointer behavior: a key or click
 * that starts inside one is never treated as an editing attempt on the
 * preview, and never pulls focus away from it.
 */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'iframe',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="dialog"]',
  '[role="grid"]',
  '[role="gridcell"]',
  '[role="listbox"]',
  '[role="searchbox"]',
  '[role="scrollbar"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="tree"]',
  '[role="treegrid"]',
  '[role="treeitem"]',
].join(', ');

const EDITING_KEYS = new Set(['Enter', 'Backspace', 'Delete']);

function isElementNode(target: EventTarget | null): target is Element {
  return (
    target !== null &&
    'nodeType' in target &&
    target.nodeType === 1 &&
    'closest' in target &&
    typeof target.closest === 'function'
  );
}

function interactiveDescendant(
  region: HTMLElement,
  target: EventTarget | null,
): boolean {
  if (!isElementNode(target)) return false;
  const match = target.closest(INTERACTIVE_SELECTOR);
  return match !== null && match !== region && region.contains(match);
}

/**
 * Whether a keydown on a rendered preview is an attempt to type into it: a
 * printable character (Shift allowed) or Enter / Backspace / Delete, with no
 * command modifier, outside composition, and not a held-key repeat. Space
 * scrolls the preview and stays out.
 */
function isPreviewEditingKey(
  event: Pick<
    globalThis.KeyboardEvent,
    | 'key'
    | 'ctrlKey'
    | 'metaKey'
    | 'altKey'
    | 'isComposing'
    | 'repeat'
    | 'defaultPrevented'
  >,
): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key === ' ' || event.key === 'Dead' || event.key === 'Process')
    return false;
  return EDITING_KEYS.has(event.key) || [...event.key].length === 1;
}

export interface FileRenderedRegionProps {
  /** `Formatted view` or `Table view`: the region's accessible name. */
  readonly label: string;
  /** Hidden read-only explanation referenced by `aria-describedby`. */
  readonly description: string;
  /**
   * Called (and the key's default prevented) for an editing keystroke on the
   * preview itself. Omit for previews that cannot be edited.
   */
  readonly onEditAttempt?: (key: string) => void;
  readonly children: ReactNode;
}

/**
 * The focusable, read-only wrapper around a rendered Markdown, CSV, or HTML
 * body (CAN-5004). It names the view, describes it as read-only, and reports
 * typing attempts so the viewer can point at the raw view. It never cancels
 * pointer input, so selection, links, and comments keep working.
 */
export const FileRenderedRegion = forwardRef<
  HTMLDivElement,
  FileRenderedRegionProps
>(function FileRenderedRegion(
  { label, description, onEditAttempt, children },
  ref,
): JSX.Element {
  const descriptionId = useId();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!onEditAttempt) return;
    if (interactiveDescendant(event.currentTarget, event.target)) return;
    if (!isPreviewEditingKey(event.nativeEvent)) return;
    // The key must not reach the selector the hint moves focus to: Enter on a
    // newly focused button would otherwise switch views on its own.
    event.preventDefault();
    onEditAttempt(event.key);
  };

  // Browsers do not all focus a tabindex container when its plain text is
  // clicked; focus it here without scrolling or touching the selection.
  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    const region = event.currentTarget;
    if (interactiveDescendant(region, event.target)) return;
    const active = region.ownerDocument.activeElement;
    if (active === region) return;
    if (active !== null && region.contains(active)) return;
    region.focus({ preventScroll: true });
  };

  return (
    <div
      ref={ref}
      role="region"
      tabIndex={0}
      aria-label={label}
      aria-describedby={descriptionId}
      data-testid="file-rendered-region"
      onKeyDown={onKeyDown}
      onClick={onClick}
      className="flex min-h-0 flex-1 flex-col outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-line-accent"
    >
      <span id={descriptionId} hidden>
        {description}
      </span>
      {children}
    </div>
  );
});
