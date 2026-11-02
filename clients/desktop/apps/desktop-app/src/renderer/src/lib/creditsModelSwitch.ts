// "Continue on <credits model>" from the usage-limit banner (CAN-4900).
//
// A chat on a model with no gateway route cannot bill to AI Credits, so the
// banner offers to move it onto the default credits model instead. The model
// switch must land before routing is saved: routing is never written against a
// model that can't carry it, and a rejected switch leaves routing untouched.

import {
  isAgentModel,
  type AgentProviderType,
  type ChatModel,
} from '@canopy/desktop-shared/types';

export interface CreditsModelSwitchOfferInput {
  model: ChatModel | undefined;
  billingProvider: AgentProviderType;
  hasWorktreeTarget: boolean;
  creditsModelRoutable: boolean;
}

/**
 * Whether this chat's notice may offer the switch. The default credits model
 * is a Codex model and the switch writes per-chat routing, so it needs a Codex
 * worktree chat and a routable target. An Agent is never switched: the plain
 * credits model would drop its instructions, so the notice names the gate
 * without the button.
 */
export function canOfferCreditsModelSwitch({
  model,
  billingProvider,
  hasWorktreeTarget,
  creditsModelRoutable,
}: CreditsModelSwitchOfferInput): boolean {
  return (
    creditsModelRoutable &&
    hasWorktreeTarget &&
    billingProvider === 'codex' &&
    !isAgentModel(model)
  );
}

export interface CreditsModelSwitchTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export type CreditsModelSwitchResult = 'switched' | 'switch-failed';

export interface ContinueOnCreditsModelDeps {
  target: CreditsModelSwitchTarget;
  creditsModel: ChatModel;
  /** Resolves true when the store accepted the model for `target`. */
  setModelAndWait: (
    model: ChatModel,
    target: CreditsModelSwitchTarget,
  ) => Promise<boolean>;
  /** Starts session-scoped AI Credits routing; false when nothing was saved. */
  enableSessionCreditsRouting: (target: CreditsModelSwitchTarget) => boolean;
}

export async function continueOnCreditsModel(
  deps: ContinueOnCreditsModelDeps,
): Promise<CreditsModelSwitchResult> {
  const { target, creditsModel, setModelAndWait, enableSessionCreditsRouting } =
    deps;
  let accepted: boolean;
  try {
    // No harness or billing framework: the ordinary model change resolves the
    // harness, and the routing written below decides billing.
    accepted = await setModelAndWait(creditsModel, target);
  } catch {
    return 'switch-failed';
  }
  if (!accepted) {
    return 'switch-failed';
  }
  return enableSessionCreditsRouting(target) ? 'switched' : 'switch-failed';
}
