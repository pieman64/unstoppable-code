import type { JSX } from 'react';
import { badgeClassName, type BadgeTone } from '../lib/badge';

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

/** Low and safe are success, medium warning, high and critical danger. */
export function riskBadgeTone(level: RiskBadgeLevel): BadgeTone {
  switch (level) {
    case 'safe':
    case 'low':
      return 'success';
    case 'medium':
      return 'warning';
    case 'high':
    case 'critical':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** Sentence-case label for a raw risk level (`low` → `Low`). */
function formatRiskLevel(level: string): string {
  return level.length > 0
    ? `${level[0].toUpperCase()}${level.slice(1)}`
    : level;
}

/**
 * "Risk Level" badge for skill rows/detail views. Ported from the desktop
 * `SkillsTab` internal; drawn on the shared Badge.
 */
export function RiskBadge({
  level,
  variant = 'stacked',
}: RiskBadgeProps): JSX.Element {
  const badge = (
    <span className={badgeClassName(riskBadgeTone(level))}>
      {formatRiskLevel(level)}
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
