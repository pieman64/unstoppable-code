import {
  BROWSER_AGENT_ACTION_STATUSES,
  BROWSER_AGENT_CONTRACT_VERSION,
  BROWSER_AGENT_NOT_EXECUTED_REASONS,
  BROWSER_AGENT_OUTCOME_UNKNOWN_REASONS,
  BrowserAgentActionReceiptSchema,
} from '@canopy/protocol/delegation/browser-agent';
import type {
  BrowserActionErrorCode,
  BrowserActionReceipt,
} from '../../types/browser';
import { projectBrowserActionOutcome } from '../browser-action-receipt-projection';

function receipt(
  status: BrowserActionReceipt['status'],
  code?: BrowserActionErrorCode,
): BrowserActionReceipt {
  return {
    actionId: 'action-1',
    sequence: 1,
    kind: 'click',
    status,
    error:
      code === undefined
        ? undefined
        : { code, message: code, retryable: false },
    durationMs: 10,
  };
}

const projectableErrors: Array<{
  code: BrowserActionErrorCode;
  reason:
    | 'target_not_found'
    | 'target_changed'
    | 'target_not_actionable'
    | 'dialog_pending';
}> = [
  { code: 'target_not_found', reason: 'target_not_found' },
  { code: 'target_stale', reason: 'target_changed' },
  { code: 'target_not_visible', reason: 'target_not_actionable' },
  { code: 'target_disabled', reason: 'target_not_actionable' },
  { code: 'target_obscured', reason: 'target_not_actionable' },
  { code: 'not_editable', reason: 'target_not_actionable' },
  { code: 'unsupported_control', reason: 'target_not_actionable' },
  { code: 'option_not_found', reason: 'target_not_actionable' },
  { code: 'frame_unavailable', reason: 'target_not_actionable' },
  { code: 'timeout', reason: 'target_not_actionable' },
  { code: 'dialog_pending', reason: 'dialog_pending' },
];

const unprojectableErrors: BrowserActionErrorCode[] = [
  'target_ambiguous',
  'policy_denied',
  'approval_denied',
  'file_not_eligible',
  'file_changed',
  'origin_changed',
  'chooser_expired',
  'disk_full',
  'unsupported_capability',
  'cancelled',
  'execution_failed',
];

describe('projectBrowserActionOutcome', () => {
  it.each(projectableErrors)(
    'projects $code as $reason',
    ({ code, reason }) => {
      const projection = projectBrowserActionOutcome(
        receipt('not_executed', code),
      );
      expect(projection).toEqual({
        projectable: true,
        status: 'not_executed',
        notExecutedReason: reason,
        effects: { navigation: 'none', dialogOpened: false },
      });
      if (projection.projectable && projection.status === 'not_executed') {
        expect(BROWSER_AGENT_ACTION_STATUSES).toContain(projection.status);
        expect(BROWSER_AGENT_NOT_EXECUTED_REASONS).toContain(
          projection.notExecutedReason,
        );
      }
    },
  );

  it.each(unprojectableErrors)(
    'does not invent a specialist reason for %s',
    (code) => {
      expect(
        projectBrowserActionOutcome(receipt('not_executed', code)),
      ).toEqual({
        projectable: false,
        reason: `No specialist not-executed reason for ${code}`,
      });
    },
  );

  it('does not infer a reason without a pre-dispatch error', () => {
    expect(projectBrowserActionOutcome(receipt('not_executed'))).toEqual({
      projectable: false,
      reason: 'Not-executed receipt lacks a pre-dispatch error',
    });
  });

  it('marks a pre-dispatch pending dialog with its dialog effect', () => {
    const projection = projectBrowserActionOutcome({
      ...receipt('not_executed', 'dialog_pending'),
      effects: {
        dialog: {
          id: 'dialog-1',
          browserId: 'browser-1',
          type: 'alert',
          message: 'Hello',
          url: 'https://example.test/path',
          openedAt: 1,
        },
      },
    });
    expect(projection).toEqual({
      projectable: true,
      status: 'not_executed',
      notExecutedReason: 'dialog_pending',
      effects: { navigation: 'none', dialogOpened: true },
    });
  });

  it.each(BROWSER_AGENT_OUTCOME_UNKNOWN_REASONS)(
    'projects unknown outcome %s',
    (reason) => {
      const projection = projectBrowserActionOutcome({
        ...receipt('outcome_unknown'),
        outcomeReason: reason,
      });
      expect(projection).toEqual({
        projectable: true,
        status: 'outcome_unknown',
        outcomeReason: reason,
        effects: { navigation: 'none', dialogOpened: false },
      });
      if (projection.projectable && projection.status === 'outcome_unknown') {
        expect(BROWSER_AGENT_ACTION_STATUSES).toContain(projection.status);
        expect(BROWSER_AGENT_OUTCOME_UNKNOWN_REASONS).toContain(
          projection.outcomeReason,
        );
      }
    },
  );

  it('requires an unknown-outcome reason', () => {
    expect(projectBrowserActionOutcome(receipt('outcome_unknown'))).toEqual({
      projectable: false,
      reason: 'Outcome-unknown receipt lacks an outcome reason',
    });
  });

  it('projects executed receipts with and without navigation and dialog effects', () => {
    const bare = projectBrowserActionOutcome(receipt('executed'));
    expect(bare).toEqual({
      projectable: true,
      status: 'executed',
      effects: { navigation: 'none', dialogOpened: false },
    });
    const withEffects = projectBrowserActionOutcome({
      ...receipt('executed'),
      effects: {
        navigation: {
          kind: 'new_document',
          committed: true,
          url: 'https://example.test/path',
        },
        dialog: {
          id: 'dialog-1',
          browserId: 'browser-1',
          type: 'alert',
          message: 'Hello',
          url: 'https://example.test/path',
          openedAt: 1,
        },
      },
    });
    expect(withEffects).toEqual({
      projectable: true,
      status: 'executed',
      effects: { navigation: 'new_document', dialogOpened: true },
    });
    if (withEffects.projectable) {
      expect(BROWSER_AGENT_ACTION_STATUSES).toContain(withEffects.status);
    }
  });

  it.each(['not_executed', 'executed', 'outcome_unknown'] as const)(
    'assembles a schema-valid protocol receipt for %s',
    (status) => {
      const projection = projectBrowserActionOutcome(
        status === 'not_executed'
          ? receipt(status, 'target_not_found')
          : status === 'outcome_unknown'
            ? { ...receipt(status), outcomeReason: 'runtime_lost' }
            : receipt(status),
      );
      expect(projection.projectable).toBe(true);
      if (!projection.projectable) return;
      const gatewayContext = {
        version: BROWSER_AGENT_CONTRACT_VERSION,
        actionId: 'action-1',
        sequence: 1,
        epoch: { delegationId: 'delegation-1', runGeneration: 1, epoch: 1 },
        subject: { tool: 'click', control: { role: 'button', name: 'Submit' } },
        recordedAt: 1,
      } as const;
      const protocolReceipt =
        projection.status === 'not_executed'
          ? {
              ...gatewayContext,
              status: projection.status,
              reason: projection.notExecutedReason,
            }
          : projection.status === 'outcome_unknown'
            ? {
                ...gatewayContext,
                status: projection.status,
                reason: projection.outcomeReason,
              }
            : {
                ...gatewayContext,
                status: projection.status,
                effects: projection.effects,
              };
      expect(
        BrowserAgentActionReceiptSchema.safeParse(protocolReceipt).success,
      ).toBe(true);
    },
  );
});
