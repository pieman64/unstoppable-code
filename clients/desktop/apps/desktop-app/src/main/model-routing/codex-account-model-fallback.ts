import {
  MAX_MODEL_ACCESS_STRING_LENGTH,
  type CodexAccountModelAccessFailure,
} from '@canopy/protocol/auth-recovery';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { classifyCodexAccountModelRejection } from '@canopy/execution-engine/agent-failures';
import { isCodexModelAvailableToAccount } from '@canopy/desktop-shared/lib/default-model-lane';
import {
  CODEX_ACCOUNT_MODELS,
  CODEX_MODELS,
  getExecutionHarnessForModel,
  getModelDisplayName,
  resolveKnownModel,
} from '@canopy/desktop-shared/types';
import { isModelExcludedByCurrentGatewayRequirement } from '../lib/model-gateway-state';
import { isModelBlockedByCurrentPolicy } from '../lib/model-policy-state';
import {
  peekCodexAccountModelIds,
  readCodexSpeedCatalog,
} from './codex-account-models';

export interface CodexAccountModelAccessFailureInput {
  error: string | undefined;
  codexErrorInfo?: unknown;
  owner: WorkOwner | undefined;
  /**
   * The runtime model the turn ran on; never offered as its own fallback. The
   * refused provider slug is always excluded as well.
   */
  turnModel?: string;
}

/**
 * The account's list for choosing a fallback. Cached when warm; on a cold
 * cache this failure path alone waits for one backoff-honouring catalog read
 * (bounded by the `model/list` timeout), never Auto's always-retrying reader.
 */
async function readAccountModelsForFallback(): Promise<ReadonlySet<string> | null> {
  const cached = peekCodexAccountModelIds();
  if (cached) return cached;
  await readCodexSpeedCatalog();
  return peekCodexAccountModelIds();
}

/** A display label within the carrier's bound; account labels may be longer. */
function carrierLabel(model: string): string {
  const label = getModelDisplayName(model);
  return label.length <= MAX_MODEL_ACCESS_STRING_LENGTH
    ? label
    : `${label.slice(0, MAX_MODEL_ACCESS_STRING_LENGTH - 1)}…`;
}

/**
 * The structured carrier for a Codex turn the signed-in ChatGPT account was
 * refused because of its model (CAN-4716), or `null` for any other failure.
 *
 * The fallback is the first Codex lane model, in catalog order then the
 * account's own models, that the account lists, policy allows, and is not the
 * refused model. With no known account list the fallback is omitted rather
 * than guessed: another catalog model could fail the same way.
 */
export async function resolveCodexAccountModelAccessFailure(
  input: CodexAccountModelAccessFailureInput,
): Promise<CodexAccountModelAccessFailure | null> {
  const rejection = classifyCodexAccountModelRejection(
    input.error,
    input.codexErrorInfo,
  );
  if (!rejection) return null;
  const accountModels = await readAccountModelsForFallback();
  const refused = new Set(
    [rejection.model, input.turnModel].filter(
      (model): model is string => typeof model === 'string',
    ),
  );
  const fallbackModel = accountModels
    ? [...CODEX_MODELS, ...CODEX_ACCOUNT_MODELS].find(
        (model) =>
          model.length <= MAX_MODEL_ACCESS_STRING_LENGTH &&
          !refused.has(model) &&
          resolveKnownModel(model) !== undefined &&
          getExecutionHarnessForModel(model) === 'codex' &&
          isCodexModelAvailableToAccount(model, accountModels) &&
          !isModelBlockedByCurrentPolicy(model, input.owner) &&
          !isModelExcludedByCurrentGatewayRequirement(model, input.owner),
      )
    : undefined;
  return {
    kind: rejection.kind,
    model: rejection.model,
    modelLabel: carrierLabel(rejection.model),
    ...(fallbackModel
      ? {
          fallbackModel,
          fallbackModelLabel: carrierLabel(fallbackModel),
        }
      : {}),
  };
}
