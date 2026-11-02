import type { RepoRulesStatus } from '@canopy/protocol/repo-rules';
import { ruleCountLabel } from './repoRulesCopy';

export interface RepoRulesAppliedToastCopy {
  readonly title: string;
  readonly message: string;
}

/**
 * Result copy for a saved Cursor rules review (CAN-4676). Hosts deliver it
 * with their own toast API and name the saved project in the toast header, so
 * the message carries no user-authored text.
 */
export function repoRulesAppliedToastCopy(result: {
  readonly status: Pick<RepoRulesStatus, 'enabled'>;
  readonly ruleCount: number;
}): RepoRulesAppliedToastCopy {
  if (!result.status.enabled)
    return {
      title: 'Cursor rules off',
      message: "New chats won't use this project's Cursor rules.",
    };
  return {
    title: 'Cursor rules on',
    message: `${ruleCountLabel(result.ruleCount)} ${
      result.ruleCount === 1 ? 'applies' : 'apply'
    } to new chats.`,
  };
}
