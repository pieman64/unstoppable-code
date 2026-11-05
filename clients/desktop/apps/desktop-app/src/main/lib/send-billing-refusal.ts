import type { DefaultModelLaneResolution } from '@canopy/desktop-shared/lib/default-model-lane';
import type { ChatModel } from '@canopy/desktop-shared/types';
import {
  resolveConcreteModelDispatchability,
  type LaneCredentialScope,
} from './default-model-lane-resolver';

/** The send refusal for a billing dead end. */
export const NO_BILLING_SOURCE_SEND_MESSAGE =
  'No model is available to send this message. Add a billing source, then try again.';

/** The send refusal when organization policy allows no runnable model. */
export const NO_POLICY_ALLOWED_MODEL_SEND_MESSAGE =
  'Your organization policy allows no model that can run this message.';

type NoDispatchableModelMissing = Extract<
  DefaultModelLaneResolution,
  { outcome: 'no-dispatchable-model' }
>['missing'];

/** The send refusal for a default-lane `no-dispatchable-model` outcome. */
export function noDispatchableModelSendMessage(
  missing: NoDispatchableModelMissing,
): string {
  return missing === 'policy-allowance'
    ? NO_POLICY_ALLOWED_MODEL_SEND_MESSAGE
    : NO_BILLING_SOURCE_SEND_MESSAGE;
}

/**
 * The billing refusal a send gets before its turn starts, or `null` to let it
 * through. Shared by the worktree, cowork and Portal send paths so they refuse
 * the same dead ends with the same words.
 *
 * `noDispatchableModel` is a default-lane resolution the caller already has;
 * this never resolves the implicit default itself. Otherwise a `concreteModel`
 * is judged by {@link resolveConcreteModelDispatchability}, which fails open:
 * a model outside the registry (including a non-concrete selection such as
 * Auto, whose runtime model is only known at dispatch) or an unsettled probe
 * gets `null`, and dispatch gives the specific error.
 */
export async function resolveSendBillingRefusal(input: {
  concreteModel?: ChatModel;
  noDispatchableModel?: { missing: NoDispatchableModelMissing };
  credentialScope: LaneCredentialScope;
}): Promise<string | null> {
  if (input.noDispatchableModel) {
    return noDispatchableModelSendMessage(input.noDispatchableModel.missing);
  }
  if (
    input.concreteModel !== undefined &&
    (await resolveConcreteModelDispatchability(
      input.concreteModel,
      input.credentialScope,
    )) === 'no-billing-lane'
  ) {
    return NO_BILLING_SOURCE_SEND_MESSAGE;
  }
  return null;
}
