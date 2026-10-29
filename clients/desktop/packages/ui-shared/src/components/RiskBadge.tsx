import type { JSX } from 'react';

/**
 * Structural stand-in for the desktop `SkillRiskLevel` union. The known
 * levels drive the color mapping; any other string falls through to the
 * neutral style, and `(string & {})` preserves literal autocomplete without
 * collapsing the union to a bare `string`.
 */
export type RiskBadgeLevel =
  | 'safe'
  | 'low'
  | 'medium'
  | 'high'
  | 'critical'
  | (string & {});

export interface RiskBadgeProps {
  level: RiskBadgeLevel;
  /**
   * `stacked` (default) is the skill-row form: a "Risk Level" caption above
   * the badge, right-aligned. `inline` renders the badge alone so a caller
   * can place it in a sentence, as the marketplace security-scan readout does.
   */
  variant?: 'stacked' | 'inline';
}

/**
 * "Risk Level" badge for skill rows/detail views. Ported from the desktop
 * `SkillsTab` internal — class names and copy match it exactly so
 * tests/selectors and visual diffs are unchanged.
 */
export function RiskBadge({
  level,
  variant = 'stacked',
}: RiskBadgeProps): JSX.Element {
  let className: string;
  switch (level) {
    case 'safe':
    case 'low':
      className = 'bg-success-subtle fg-success border-line-positive';
      break;
    case 'medium':
      className = 'bg-warning-subtle fg-warning border-line-attention';
      break;
    case 'high':
    case 'critical':
      className =
        'bg-destructive-subtle fg-destructive border-line-destructive';
      break;
    default:
      className = 'bg-secondary fg-secondary';
  }

  const badge = (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-3xs font-medium border ${className}`}
    >
      {level}
    </span>
  );
  if (variant === 'inline') return badge;
  return (
    <div className="flex flex-col items-end">
      <span className="text-3xs fg-secondary mb-0.5">Risk level</span>
      {badge}
    </div>
  );
}
