import type {
  BrowserActionErrorCode,
  BrowserActionReceipt,
} from '../types/browser';
import type { BrowserAgentActionReceipt } from '@canopy/protocol/delegation/browser-agent';

type ProjectedEffects = {
  navigation: 'none' | 'same_document' | 'new_document';
  dialogOpened: boolean;
};

export type BrowserActionOutcomeProjection =
  | {
      projectable: true;
      status: 'not_executed';
      notExecutedReason: Extract<
        BrowserAgentActionReceipt,
        { status: 'not_executed' }
      >['reason'];
      effects: ProjectedEffects;
    }
  | {
      projectable: true;
      status: 'executed';
      effects: ProjectedEffects;
    }
  | {
      projectable: true;
      status: 'outcome_unknown';
      outcomeReason: Extract<
        BrowserAgentActionReceipt,
        { status: 'outcome_unknown' }
      >['reason'];
      effects: ProjectedEffects;
    }
  | { projectable: false; reason: string };

function unprojectable(reason: string): BrowserActionOutcomeProjection {
  return { projectable: false, reason };
}

function projectErrorCode(
  code: BrowserActionErrorCode,
  effects: ProjectedEffects,
): BrowserActionOutcomeProjection {
  switch (code) {
    case 'target_not_found':
      return {
        projectable: true,
        status: 'not_executed',
        notExecutedReason: 'target_not_found',
        effects,
      };
    case 'target_stale':
      return {
        projectable: true,
        status: 'not_executed',
        notExecutedReason: 'target_changed',
        effects,
      };
    case 'target_not_visible':
    case 'target_disabled':
    case 'target_obscured':
    case 'not_editable':
    case 'unsupported_control':
    case 'option_not_found':
    case 'frame_unavailable':
    case 'timeout':
      return {
        projectable: true,
        status: 'not_executed',
        notExecutedReason: 'target_not_actionable',
        effects,
      };
    case 'dialog_pending':
      return {
        projectable: true,
        status: 'not_executed',
        notExecutedReason: 'dialog_pending',
        effects,
      };
    case 'target_ambiguous':
    case 'policy_denied':
    case 'approval_denied':
    case 'file_not_eligible':
    case 'file_changed':
    case 'origin_changed':
    case 'chooser_expired':
    case 'disk_full':
    case 'unsupported_capability':
    case 'cancelled':
    case 'execution_failed':
      return unprojectable(`No specialist not-executed reason for ${code}`);
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

/** Project only evidence that the specialist's browser receipt can express. */
export function projectBrowserActionOutcome(
  receipt: BrowserActionReceipt,
): BrowserActionOutcomeProjection {
  if (receipt.status === 'outcome_unknown') {
    if (receipt.outcomeReason === undefined) {
      return unprojectable('Outcome-unknown receipt lacks an outcome reason');
    }
    return {
      projectable: true,
      status: 'outcome_unknown',
      outcomeReason: receipt.outcomeReason,
      effects: {
        navigation: receipt.effects?.navigation?.kind ?? 'none',
        dialogOpened: receipt.effects?.dialog !== undefined,
      },
    };
  }
  if (receipt.status === 'executed') {
    return {
      projectable: true,
      status: 'executed',
      effects: {
        navigation: receipt.effects?.navigation?.kind ?? 'none',
        dialogOpened: receipt.effects?.dialog !== undefined,
      },
    };
  }
  if (receipt.error === undefined) {
    return unprojectable('Not-executed receipt lacks a pre-dispatch error');
  }
  return projectErrorCode(receipt.error.code, {
    navigation: receipt.effects?.navigation?.kind ?? 'none',
    dialogOpened: receipt.effects?.dialog !== undefined,
  });
}
