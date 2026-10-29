import type { JSX } from 'react';
import type { SkillRiskInfo } from '@canopy/protocol/skills';
import { RiskBadge } from './RiskBadge';

export interface SecurityAuditSummaryProps {
  audit: SkillRiskInfo;
  dataTestId?: string;
}

/**
 * One-line "Security scan" readout for a marketplace listing: the shared
 * RiskBadge for the rolled-up level plus the Socket alert count when there is
 * one. An `unknown` level means the advisory scan has no result for at least
 * one of the plugin's skills (the service never indexed the repository, or has
 * not covered every skill). That reads as "not available" rather than as a
 * neutral "unknown" badge or as "pending", which would promise a result the
 * service may never produce.
 */
export function SecurityAuditSummary({
  audit,
  dataTestId,
}: SecurityAuditSummaryProps): JSX.Element {
  if (audit.level === 'unknown') {
    return <span data-testid={dataTestId}>Security scan: not available</span>;
  }
  const alerts = audit.socketAlerts ?? 0;
  return (
    <span className="inline-flex items-center gap-1.5" data-testid={dataTestId}>
      <span>Security scan:</span>
      <RiskBadge level={audit.level} variant="inline" />
      {alerts > 0 && (
        <span>
          {alerts} Socket {alerts === 1 ? 'alert' : 'alerts'}
        </span>
      )}
    </span>
  );
}
