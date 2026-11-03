import type { JSX, ReactNode } from 'react';

interface AttentionDotProps {
  /**
   * The tab's visible text. Rendered as-is; the dot is positioned relative to
   * it, so the label and its marker cannot drift apart.
   */
  children: ReactNode;
  /** Announced description, e.g. `"Billing needs attention"`. */
  label: string;
  testId: string;
}

/**
 * A tab label with the "needs attention" dot overlaid on its top-right corner.
 *
 * Used by the settings rail (`SettingsNavGroups`). One component keeps
 * the accessibility fix below in a single place.
 *
 * `role="img"` is load-bearing, not decoration. The dot is 6px of pure color
 * with no text, so `aria-label` is its ONLY accessible content — and
 * `aria-label` is prohibited on the implicit `generic` role a bare `<span>`
 * carries, which leaves browsers and screen readers free to drop it entirely.
 * A role that supports naming from author makes the announcement reliable.
 */
export function AttentionDot({
  children,
  label,
  testId,
}: AttentionDotProps): JSX.Element {
  return (
    <span className="relative">
      {children}
      <span
        role="img"
        aria-label={label}
        data-testid={testId}
        className="absolute -right-2 -top-1 h-1.5 w-1.5 rounded-full bg-destructive"
      />
    </span>
  );
}
