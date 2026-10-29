/**
 * Last input modality per document, so focus handlers can apply native
 * `:focus-visible` semantics: react to focus that the user reached by keyboard
 * (Tab, arrows, Enter/Space, Escape …), never to focus that followed a pointer
 * press or that a script moved with `.focus()`.
 *
 * Why not `element.matches(':focus-visible')`? Two reasons. jsdom matches it
 * for every focused element, so tests could never tell keyboard focus from
 * programmatic focus. And Chromium matches it for programmatic focus that
 * happens before any user interaction (page load, `autofocus`), which is
 * precisely the case tooltip triggers must stay quiet for. Tracking the
 * user's last input event is the reliable signal, so it is authoritative here.
 *
 * Tracking installs once per `Document`, in the capture phase so a bubbling
 * listener that stops propagation cannot starve it. Components that consult
 * `wasFocusVisible` call `trackInputModality` when they mount: the first query
 * also installs it, but by then the Tab press that caused that first focus has
 * already happened and would be missed. Keydowns carrying
 * Ctrl/Meta/Alt are app shortcuts rather than focus navigation and are ignored,
 * mirroring the `:focus-visible` heuristic. Once the user is driving by
 * keyboard, scripted focus moves (a menu returning focus to its trigger after
 * Escape) still count as visible until the pointer is used again — the same
 * rule browsers apply.
 */
type InputModality = 'keyboard' | 'pointer';

const POINTER_EVENTS = ['pointerdown', 'mousedown', 'touchstart'] as const;

const modalityByDocument = new WeakMap<Document, InputModality | null>();

/**
 * Starts recording input modality for `doc`. Idempotent; call it from a mount
 * effect of any component whose focus handler reads `wasFocusVisible`, so the
 * keydown that precedes the user's first keyboard focus is seen.
 */
export function trackInputModality(doc: Document): void {
  if (modalityByDocument.has(doc)) return;
  modalityByDocument.set(doc, null);
  doc.addEventListener(
    'keydown',
    (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      modalityByDocument.set(doc, 'keyboard');
    },
    true,
  );
  for (const type of POINTER_EVENTS) {
    doc.addEventListener(
      type,
      (): void => {
        modalityByDocument.set(doc, 'pointer');
      },
      true,
    );
  }
}

/**
 * Whether focus landing on `target` was reached by keyboard. Call it from a
 * focus handler; it reads the modality of the last input event in `target`'s
 * document, so pointer-driven and programmatic focus both report `false`.
 */
export function wasFocusVisible(target: Element): boolean {
  const doc = target.ownerDocument;
  trackInputModality(doc);
  return modalityByDocument.get(doc) === 'keyboard';
}

/**
 * Forgets the recorded modality for `doc` (listeners stay installed). Test
 * helper: jsdom shares one document across a file's cases, so a keydown in one
 * case would otherwise leak keyboard modality into the next.
 */
export function resetInputModality(doc: Document): void {
  trackInputModality(doc);
  modalityByDocument.set(doc, null);
}
