/**
 * DOM checks for composer activity that blocks automatic release highlights
 * (CAN-5006). Every mounted composer counts, hidden ones included, so a draft
 * left in an inactive tab still blocks.
 */

/** Chat composers (`ChatInput`) and the Home composer box. */
export const COMPOSER_ROOT_SELECTOR =
  '[data-chat-composer-root], [data-testid="home-composer"]';

const EDITOR_SELECTOR = '[data-chat-textarea]';

/**
 * Draft items rendered beside the editable text: inline file references and
 * the staged attachment/selection strip above the editor.
 */
const DRAFT_ITEM_SELECTOR =
  '[data-testid="file-reference-pill"], [data-testid="attachment-strip"]';

/** Slate's placeholder and the zero-width filler it renders for empty text. */
const NON_DRAFT_TEXT_SELECTOR =
  '[data-slate-placeholder], [data-slate-zero-width]';

export function isComposerFocused(doc: Document): boolean {
  const active = doc.activeElement;
  return active !== null && active.closest(COMPOSER_ROOT_SELECTOR) !== null;
}

function editorHasText(editor: Element): boolean {
  const doc = editor.ownerDocument;
  const walker = doc.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent?.closest(NON_DRAFT_TEXT_SELECTOR)) continue;
    if ((node.nodeValue ?? '').replace(/\uFEFF/g, '').trim() !== '') {
      return true;
    }
  }
  return false;
}

export function hasComposerDraft(doc: Document): boolean {
  for (const root of Array.from(doc.querySelectorAll(COMPOSER_ROOT_SELECTOR))) {
    if (root.querySelector(DRAFT_ITEM_SELECTOR) !== null) return true;
    for (const editor of Array.from(root.querySelectorAll(EDITOR_SELECTOR))) {
      if (editorHasText(editor)) return true;
    }
  }
  return false;
}

/**
 * Observe text and draft items inside mounted composer roots. A lightweight
 * discovery observer notices roots added/removed during navigation; it never
 * reads editor text or rescans existing composers for unrelated DOM changes.
 */
export function watchComposerDrafts(
  doc: Document,
  onChange: () => void,
): () => void {
  const view = doc.defaultView;
  if (!view || !doc.body) return (): void => undefined;
  const Observer = view.MutationObserver;
  const ElementClass = view.Element;
  const roots = new Map<Element, MutationObserver>();
  function observeRoot(root: Element): void {
    if (roots.has(root)) return;
    const observer = new Observer(onChange);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    roots.set(root, observer);
  }
  function discover(node: Node): void {
    if (!(node instanceof ElementClass)) return;
    if (node.matches(COMPOSER_ROOT_SELECTOR)) observeRoot(node);
    for (const root of Array.from(
      node.querySelectorAll(COMPOSER_ROOT_SELECTOR),
    ))
      observeRoot(root);
  }
  discover(doc.body);
  const discovery = new Observer((records): void => {
    let changed = false;
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        const size = roots.size;
        discover(node);
        if (roots.size !== size) changed = true;
      }
      if (record.removedNodes.length > 0) {
        for (const [root, observer] of Array.from(roots)) {
          if (root.isConnected) continue;
          observer.disconnect();
          roots.delete(root);
          changed = true;
        }
      }
    }
    if (changed) onChange();
  });
  discovery.observe(doc.body, { childList: true, subtree: true });
  return (): void => {
    discovery.disconnect();
    for (const observer of Array.from(roots.values())) observer.disconnect();
    roots.clear();
  };
}
