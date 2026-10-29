/**
 * Container chrome shared by every Usage card (Claude, Codex, AI Credits).
 *
 * Written once here rather than inline per card for the same reason
 * {@link ../UsageCardHeader} was extracted: the per-card copies were identical
 * by contract but maintained separately, so they were free to drift. The framed
 * variant is the standalone Usage page; the frameless variant lets the Usage
 * panel's divided sections fill their parent.
 */
export function usageCardContainerClass({
  compact,
  frameless,
}: {
  /** Panel density — trims padding for small panels. */
  compact: boolean;
  /** Strips the card box (border/background/rounded corners). */
  frameless: boolean;
}): string {
  if (frameless) {
    return compact ? 'py-3' : 'py-4';
  }
  return compact
    ? 'rounded-xl border bg-card/60 p-4'
    : 'rounded-2xl border bg-card/60 p-5';
}
