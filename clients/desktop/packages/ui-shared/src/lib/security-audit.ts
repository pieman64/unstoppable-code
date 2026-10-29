import type { SkillRiskInfo, SkillRiskLevel } from '@canopy/protocol/skills';

const SKILL_RISK_LEVELS: readonly SkillRiskLevel[] = [
  'safe',
  'low',
  'medium',
  'high',
  'critical',
  'unknown',
];

function isSkillRiskLevel(value: unknown): value is SkillRiskLevel {
  return (
    typeof value === 'string' &&
    SKILL_RISK_LEVELS.some((level) => level === value)
  );
}

/**
 * Validate a plugin-level security audit before rendering it. Catalog rows
 * can be relayed from a desktop or an older server, so the wire type is a
 * promise the UI must not trust: anything but a known level with an optional
 * non-negative integer alert count reads as "no audit".
 */
export function parseSecurityAudit(value: unknown): SkillRiskInfo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const level: unknown = Reflect.get(value, 'level');
  if (!isSkillRiskLevel(level)) return null;
  const alerts: unknown = Reflect.get(value, 'socketAlerts');
  if (alerts === undefined || alerts === null) {
    return { level, socketAlerts: null };
  }
  if (typeof alerts !== 'number' || !Number.isInteger(alerts) || alerts < 0) {
    return null;
  }
  return { level, socketAlerts: alerts };
}
