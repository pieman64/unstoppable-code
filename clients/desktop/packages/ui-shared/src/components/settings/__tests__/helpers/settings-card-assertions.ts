import {
  SETTINGS_CARD_CLASS,
  SETTINGS_CARD_SUBTITLE_CLASS,
  SETTINGS_CARD_TITLE_CLASS,
} from '../../SettingsCard';

/**
 * Shared assertions for the settings-card shell.
 *
 * These deliberately query the DOM instead of substring-matching serialized
 * HTML. Serialized assertions coupled five suites to React's attribute-emission
 * order, so adding an `id`, spreading props, or simply reordering JSX
 * attributes reddened all of them for a reason unrelated to behavior. The
 * negative guards had the mirror problem: written as a substring of a fixed
 * class string, any Tailwind class reordering made them pass vacuously and the
 * "old shell is gone" guarantee silently evaporated.
 */

/** The pre-refactor bordered, unmedallioned card shell. */
const LEGACY_CARD_CLASSES = [
  'rounded-xl',
  'border',
  'border-border',
  'bg-card',
  'p-6',
];

/** Parse serialized markup into a queryable DOM root (jsdom environment). */
export function parseMarkup(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

/**
 * Assert `testId` names a settings-card shell: a `<section>` carrying exactly
 * the shared shell classes.
 */
export function expectSettingsCardShell(
  root: ParentNode,
  testId: string,
): void {
  const card = root.querySelector(`[data-testid="${testId}"]`);

  expect(card).not.toBeNull();
  expect(card?.tagName).toBe('SECTION');
  expect(card?.getAttribute('class')).toBe(SETTINGS_CARD_CLASS);
}

/**
 * Assert exactly one `<h2>` renders `text` with the shared card title style.
 * Order-independent, and the count guards against a heading being rendered
 * twice (once by the card, once by the body it wraps).
 */
export function expectSettingsCardHeading(
  root: ParentNode,
  text: string,
): void {
  const headings = Array.from(root.querySelectorAll('h2')).filter(
    (heading) => heading.textContent === text,
  );

  expect(headings).toHaveLength(1);
  expect(headings[0]?.getAttribute('class')).toBe(SETTINGS_CARD_TITLE_CLASS);
}

/**
 * Assert the card named by `testId` renders a non-empty subtitle in the shared
 * style. Asserting presence rather than exact copy keeps wording edits out of
 * the suite while still catching a card that ships with a bare title.
 */
export function expectSettingsCardSubtitle(
  root: ParentNode,
  testId: string,
): void {
  // Anchored to the heading rather than to a class query over the whole card,
  // so a body paragraph that happens to share the style cannot satisfy it.
  const heading = root.querySelector(`[data-testid="${testId}"] h2`);
  const subtitle = heading?.nextElementSibling ?? null;

  expect(heading).not.toBeNull();
  expect(subtitle?.tagName).toBe('P');
  expect(subtitle?.getAttribute('class')).toBe(SETTINGS_CARD_SUBTITLE_CLASS);
  expect(subtitle?.textContent?.trim()).not.toBe('');
}

/**
 * Assert no card heading renders `text`. Used to keep a card from restating the
 * label of the settings tab it lives under, which reads as a duplicated title
 * and tells the reader nothing they did not just click.
 */
export function expectNoSettingsCardHeading(
  root: ParentNode,
  text: string,
): void {
  const headings = Array.from(root.querySelectorAll('h2')).filter(
    (heading) => heading.textContent === text,
  );

  expect(headings).toHaveLength(0);
}

/**
 * Assert nothing still carries the pre-refactor bordered card shell. Checked
 * through `classList` so the guard cannot pass vacuously if the class order
 * changes.
 */
export function expectNoLegacyCardShell(root: ParentNode): void {
  const legacy = Array.from(root.querySelectorAll('*')).filter((element) =>
    LEGACY_CARD_CLASSES.every((className) =>
      element.classList.contains(className),
    ),
  );

  expect(legacy).toHaveLength(0);
}
