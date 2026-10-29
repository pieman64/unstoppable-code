/**
 * Pinned height of a section's sticky user message. Summary chips stick
 * right below it with `top: calc(var(--chat-sticky-user-height) + 0.5rem)`.
 */
export const STICKY_USER_HEIGHT_PROPERTY = '--chat-sticky-user-height';
const STICKY_TURN_SUMMARY_SELECTOR = '[data-testid="sticky-turn-summary"]';
/** Section attribute holding the published height. No selector reads it. */
export const STICKY_USER_HEIGHT_ATTRIBUTE = 'data-chat-sticky-user-height';

export function applyStickyUserHeight(
  chip: HTMLElement,
  height: string | undefined,
): void {
  if (height === undefined) {
    chip.style.removeProperty(STICKY_USER_HEIGHT_PROPERTY);
  } else if (
    chip.style.getPropertyValue(STICKY_USER_HEIGHT_PROPERTY) !== height
  ) {
    chip.style.setProperty(STICKY_USER_HEIGHT_PROPERTY, height);
  }
}

/**
 * Publishes a section's pinned header height, or clears it with `undefined`.
 *
 * Custom properties inherit, so setting one on the section would restyle
 * every element of the section's turns (a whole turn of rendered Markdown)
 * each time the header is measured. The value goes on the summary chips,
 * which are its only consumers. The section keeps it in a data attribute
 * that no selector reads, for chips that mount later and for scroll math.
 */
export function publishStickyUserHeight(
  section: HTMLElement,
  height: string | undefined,
): void {
  if (height === undefined) {
    section.removeAttribute(STICKY_USER_HEIGHT_ATTRIBUTE);
  } else if (section.getAttribute(STICKY_USER_HEIGHT_ATTRIBUTE) !== height) {
    section.setAttribute(STICKY_USER_HEIGHT_ATTRIBUTE, height);
  }
  section
    .querySelectorAll<HTMLElement>(STICKY_TURN_SUMMARY_SELECTOR)
    .forEach((chip) => applyStickyUserHeight(chip, height));
}

/** The pinned header height last published for a section, in pixels. */
export function readStickyUserHeight(section: HTMLElement): number {
  const height = Number.parseFloat(
    section.getAttribute(STICKY_USER_HEIGHT_ATTRIBUTE) ?? '',
  );
  return Number.isFinite(height) ? height : 0;
}
