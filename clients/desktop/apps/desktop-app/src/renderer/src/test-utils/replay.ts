import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

/**
 * Session-replay marker helpers for jsdom component tests (CAN-3119). Shared
 * so the many replay privacy tests assert markers the same way.
 */

/** The outermost replay block at or above `element`, or `null`. */
export function outermostReplayBlock(
  element: Element | null | undefined,
): Element | null {
  let block: Element | null = null;
  for (let node = element ?? null; node; node = node.parentElement) {
    if (node.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)) block = node;
  }
  return block;
}

/**
 * Asserts a personal identity value (a name, email, or login) renders under
 * `root` only inside replay blocks that hold exactly that value, and that no
 * recorded attribute carries it. The surrounding copy ("Signed in as") and
 * controls therefore stay recorded.
 */
export function expectReplayBlocksOnlyValue(
  root: Element,
  value: string,
): void {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  let occurrences = 0;
  const unblocked: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue?.includes(value)) continue;
    occurrences += 1;
    const block = outermostReplayBlock(node.parentElement);
    if (block?.textContent !== value) {
      unblocked.push(
        block?.textContent ?? node.parentElement?.textContent ?? '',
      );
    }
  }
  expect(occurrences).toBeGreaterThan(0);
  expect(unblocked).toEqual([]);

  // A block records only its own class and size, so attributes inside one
  // are dropped; everywhere else every attribute is recorded.
  const recordedAttributes: string[] = [];
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (outermostReplayBlock(element) !== null) continue;
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.value.includes(value)) {
        recordedAttributes.push(
          `${element.tagName.toLowerCase()}[${attribute.name}]`,
        );
      }
    }
  }
  expect(recordedAttributes).toEqual([]);
}

/** The class list of the root element in server-rendered `markup`. */
export function rootClassList(markup: string): string[] {
  const match = /^<[a-z]+ class="([^"]*)"/.exec(markup);
  return match?.[1]?.split(' ') ?? [];
}

/** Asserts `content` sits in a modal `DialogModal` card that no replay block
 * covers, and returns the card. */
export function expectInRecordedDialogCard(content: Element): HTMLElement {
  const card = content.closest<HTMLElement>('[role="dialog"]');
  if (card === null) throw new Error('Content is not inside a dialog card');
  expect(card.getAttribute('aria-modal')).toBe('true');
  expect(card.parentElement?.getAttribute('data-canopy-overlay-root')).toBe(
    'modal',
  );
  // `closest` is inclusive: the card and its ancestors carry no block.
  expect(card.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  return card;
}

/** Like {@link expectInRecordedDialogCard}, and also asserts `content` sits
 * in a replay block strictly inside the card. */
export function expectBlockedInRecordedDialogCard(
  content: Element,
): HTMLElement {
  const card = expectInRecordedDialogCard(content);
  const blockRoot = content.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`);
  expect(blockRoot).not.toBeNull();
  expect(blockRoot !== card && card.contains(blockRoot)).toBe(true);
  return card;
}
