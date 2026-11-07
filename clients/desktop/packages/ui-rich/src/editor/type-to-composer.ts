import { useEffect, type RefObject } from 'react';
import {
  PANEL_CONTENT_ADOPTED_EVENT,
  PANEL_CONTENT_HOST_ATTRIBUTE,
} from '@canopy/ui-shared/panels';

/** A composer that can take typing that started outside it. */
export interface TypeToComposerTarget {
  /** The editable element, or null before the editor has rendered. */
  readonly getElement: () => HTMLElement | null;
  /** Moves focus into the editor synchronously. */
  readonly focus: () => void;
}

/** What {@link isComposerTypingKey} reads from a keyboard event. */
export type ComposerTypingKeyEvent = Pick<
  KeyboardEvent,
  | 'key'
  | 'code'
  | 'keyCode'
  | 'metaKey'
  | 'ctrlKey'
  | 'altKey'
  | 'repeat'
  | 'isComposing'
  | 'getModifierState'
>;

interface RegisteredComposer {
  readonly target: TypeToComposerTarget;
  /** Order of the last focus inside this composer; 0 means never focused. */
  focusOrder: number;
}

interface DocumentRegistry {
  readonly composers: Set<RegisteredComposer>;
  focusCount: number;
  readonly dispose: () => void;
}

/**
 * Focus inside any of these keeps its keys: places that accept text, embedded
 * documents, and widgets that use letters for type-ahead or their own commands.
 * Monaco and the terminal are named because their input element is an
 * implementation detail that changes with the input mode.
 */
const KEY_OWNER_SELECTOR = [
  'input',
  'textarea',
  'select',
  'iframe',
  'webview',
  'embed',
  'object',
  '[contenteditable]:not([contenteditable="false"])',
  '.monaco-editor',
  '.xterm',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="tree"]',
  '[role="treegrid"]',
  '[role="grid"]',
  '[role="slider"]',
  '[role="spinbutton"]',
].join(', ');

/** Open dialogs, menus and pickers, which all render one of these roles. */
const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]';

const ACTIVE_PANEL_GROUP_SELECTOR = '.canopy-panel-group[data-active="true"]';

/**
 * Whether a key press would type text. Space stays out: it activates the
 * focused control or scrolls the transcript, and a message never starts with
 * one. `Process` and `Dead` start a composition; focus moves for them too so
 * the input method's text lands in the composer, and the browser still does
 * the inserting, so nothing is dropped or doubled.
 */
export function isComposerTypingKey(event: ComposerTypingKeyEvent): boolean {
  if (event.isComposing || event.repeat || event.metaKey) return false;
  // Windows reports AltGr as Ctrl+Alt, and it types characters such as @.
  if ((event.ctrlKey || event.altKey) && !event.getModifierState('AltGraph')) {
    return false;
  }
  if (event.key === ' ' || event.code === 'Space') return false;
  if (event.key === 'Process' || event.key === 'Dead') return true;
  if (event.keyCode === 229) return true;
  return Array.from(event.key).length === 1;
}

function hasClosest(target: EventTarget | null): target is Element {
  return target !== null && 'closest' in target;
}

function isShown(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  return (
    element.getClientRects().length > 0 &&
    view?.getComputedStyle(element).visibility !== 'hidden' &&
    element.closest('[inert], [aria-hidden="true"]') === null
  );
}

function hasOpenOverlay(doc: Document): boolean {
  return Array.from(doc.querySelectorAll(OVERLAY_SELECTOR)).some(isShown);
}

function hasTextSelection(doc: Document): boolean {
  const selection = doc.getSelection();
  return selection !== null && !selection.isCollapsed;
}

/**
 * The composer on screen that typing belongs to: the one in the active panel
 * group when it has one, otherwise the one the user was last in. A disabled
 * or absent composer never spills typing into a neighbouring split.
 */
function pickComposer(
  composers: ReadonlySet<RegisteredComposer>,
  doc: Document,
): {
  readonly composer: RegisteredComposer;
  readonly element: HTMLElement;
} | null {
  const shown = Array.from(composers).flatMap((composer) => {
    const element = composer.target.getElement();
    return element !== null && element.ownerDocument === doc && isShown(element)
      ? [{ composer, element }]
      : [];
  });
  const activeGroup =
    Array.from(doc.querySelectorAll(ACTIVE_PANEL_GROUP_SELECTOR)).find(
      isShown,
    ) ?? null;
  const inActiveGroup = shown.filter((entry) =>
    activeGroup?.contains(entry.element),
  );
  const pool = activeGroup === null ? shown : inActiveGroup;
  // Later registrations sit last in the set, so ties go to the newest mount.
  return pool.reduce<(typeof pool)[number] | null>(
    (best, entry) =>
      best === null || entry.composer.focusOrder >= best.composer.focusOrder
        ? entry
        : best,
    null,
  );
}

function routeTypingToComposer(
  event: KeyboardEvent,
  registry: DocumentRegistry,
  doc: Document,
): void {
  if (event.defaultPrevented || !isComposerTypingKey(event)) return;
  if (hasClosest(event.target) && event.target.closest(KEY_OWNER_SELECTOR)) {
    return;
  }
  if (hasOpenOverlay(doc) || hasTextSelection(doc)) return;
  const picked = pickComposer(registry.composers, doc);
  if (picked === null || !picked.element.isContentEditable) return;
  // Default action not prevented: the browser delivers this key's text to
  // whatever holds focus once keydown returns, so the composer receives it the
  // ordinary way, through the input method when one is active.
  picked.composer.target.focus();
}

const registries = new WeakMap<Document, DocumentRegistry>();

function createRegistry(doc: Document, view: Window): DocumentRegistry {
  const registry: DocumentRegistry = {
    composers: new Set(),
    focusCount: 0,
    dispose: (): void => {
      view.removeEventListener('keydown', onKeyDown);
      doc.removeEventListener('focusin', onFocusIn);
      registries.delete(doc);
    },
  };
  // On the window, in the bubble phase: anything that claims a key first has
  // already prevented its default by the time it gets here.
  function onKeyDown(event: KeyboardEvent): void {
    routeTypingToComposer(event, registry, doc);
  }
  function onFocusIn(event: FocusEvent): void {
    if (!hasClosest(event.target)) return;
    for (const composer of registry.composers) {
      if (composer.target.getElement()?.contains(event.target)) {
        registry.focusCount += 1;
        composer.focusOrder = registry.focusCount;
        return;
      }
    }
  }
  view.addEventListener('keydown', onKeyDown);
  doc.addEventListener('focusin', onFocusIn);
  return registry;
}

/**
 * Lets `target` receive typing that starts elsewhere in `doc`. One listener
 * serves every composer of a document, including a panel popped out into its
 * own window, whatever the number of warm chats kept mounted.
 */
export function registerTypeToComposerTarget(
  doc: Document,
  target: TypeToComposerTarget,
): () => void {
  const view = doc.defaultView;
  if (view === null) return (): void => undefined;
  const registry = registries.get(doc) ?? createRegistry(doc, view);
  registries.set(doc, registry);
  const composer: RegisteredComposer = { target, focusOrder: 0 };
  registry.composers.add(composer);
  return (): void => {
    registry.composers.delete(composer);
    if (registry.composers.size === 0) registry.dispose();
  };
}

/** Registers the editable inside `containerRef` while `enabled` is true. */
export function useTypeToComposer(
  containerRef: RefObject<HTMLElement | null>,
  focus: () => void,
  enabled: boolean,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || container === null) return undefined;
    let doc = container.ownerDocument;
    const target: TypeToComposerTarget = {
      getElement: () =>
        container.querySelector<HTMLElement>('[data-chat-textarea]'),
      focus,
    };
    let dispose = registerTypeToComposerTarget(doc, target);
    // Panel hosts adopt the existing React subtree into auxiliary windows.
    // The host and hook stay mounted, so follow the host's adoption event.
    const host = container.closest(`[${PANEL_CONTENT_HOST_ATTRIBUTE}]`);
    const onAdopted = (): void => {
      if (container.ownerDocument === doc) return;
      dispose();
      doc = container.ownerDocument;
      dispose = registerTypeToComposerTarget(doc, target);
    };
    host?.addEventListener(PANEL_CONTENT_ADOPTED_EVENT, onAdopted);
    return (): void => {
      host?.removeEventListener(PANEL_CONTENT_ADOPTED_EVENT, onAdopted);
      dispose();
    };
  }, [containerRef, enabled, focus]);
}
