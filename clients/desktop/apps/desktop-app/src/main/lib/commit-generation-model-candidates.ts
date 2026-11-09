/**
 * Ordered model candidates for commit-message generation (CAN-3866).
 *
 * Commit-message generation is a background helper; a helper failure must never
 * abort the git action it serves. `generateCommitMessage` walks this chain and
 * only falls back to the branch title once every candidate has failed.
 *
 * Collection order: the configured commit model, the selected worktree
 * provider's default, the other native provider's default, then the AI Credits
 * default lane (only within the user's AI Credits routing consent). The list
 * is then deduped, stripped of unknown and policy-blocked fallback ids (the
 * primary is policy-checked per attempt with the workspace owner),
 * quota-limited native candidates are demoted (unless the gateway can still
 * route them), and finally capped. Dropped candidates never consume a slot
 * because the cap is applied last. A local (Ollama) primary gets no
 * fallbacks, so its diff never leaves the machine.
 */
import {
  getProviderForModel,
  isOllamaModel,
  resolveKnownModel,
  type AgentProviderType,
  type AiCreditsRoutingMode,
  type ChatModel,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import { CREDITS_LANE_DEFAULT_CANDIDATES } from '@canopy/desktop-shared/lib/default-model-lane';
import { isGatewayRoutableModel } from '@canopy/execution-engine/lib/gateway-model-availability';
import { isProviderQuotaReached } from '../agents/ai-credits-quota-state';
import {
  isModelBlockedByStoredPolicy,
  isStoredModelPolicyReadDegraded,
} from './model-policy-state';
import { logMainProcessWarn } from './main-process-logging';
import { resolveHelperWorkOwner } from '../ollama/helper-invocation';

export const MAX_COMMIT_GENERATION_MODEL_CANDIDATES = 4;

export interface CommitGenerationModelPlan {
  model: ChatModel;
  fallbackModels: ChatModel[];
  /** Passed back to `generateCommitMessage` for its mid-chain demotion. */
  aiCreditsRoutingMode?: AiCreditsRoutingMode;
}

export interface ResolveCommitGenerationModelCandidatesInput {
  preferences: PreferencesData;
  /** Configured `commitGenerationModel`. */
  primaryModel: ChatModel;
  /** Workspace whose owner scopes the fallback policy check. */
  workspaceId?: string;
}

function worktreeDefaultModel(
  preferences: PreferencesData,
  provider: AgentProviderType,
): ChatModel | undefined {
  return preferences.defaultWorktreeModelByProvider[provider]?.model;
}

/**
 * Gateway-only credits models route and bill regardless of routing mode, so
 * they join only within the user's AI Credits consent: always for `on`, and
 * for `on-quota` only once a native lane's quota is exhausted.
 *
 * Decided once per plan. A native limit first hit mid-chain does not add the
 * credits lane to that commit: this fails closed on spend, and the next commit
 * resolves with the latched lane.
 */
function creditsLaneConsented(preferences: PreferencesData): boolean {
  if (preferences.aiCreditsRoutingMode === 'on') {
    return true;
  }
  return (
    preferences.aiCreditsRoutingMode === 'on-quota' &&
    (isProviderQuotaReached('claude') || isProviderQuotaReached('codex'))
  );
}

function collectCandidates(
  input: ResolveCommitGenerationModelCandidatesInput,
): ChatModel[] {
  const { preferences, primaryModel } = input;
  const selected = preferences.defaultWorktreeProvider;
  const otherNative: AgentProviderType[] =
    selected === 'claude'
      ? ['codex']
      : selected === 'codex'
        ? ['claude']
        : ['claude', 'codex'];

  // Cursor, Copilot and OpenCode cannot run background helpers, so their
  // default would only burn a slot on a guaranteed failure.
  const selectedRunsHelpers =
    selected === 'claude' || selected === 'codex' || selected === 'ollama';

  const candidates: (ChatModel | undefined)[] = [
    primaryModel,
    selectedRunsHelpers
      ? worktreeDefaultModel(preferences, selected)
      : undefined,
    ...otherNative.map((provider) =>
      worktreeDefaultModel(preferences, provider),
    ),
    ...(creditsLaneConsented(preferences)
      ? CREDITS_LANE_DEFAULT_CANDIDATES
      : []),
  ];
  return candidates.filter(
    (model): model is ChatModel => typeof model === 'string' && model !== '',
  );
}

/**
 * True when the model's native lane is quota-limited and the gateway cannot
 * carry it. Also read between attempts by `generateCommitMessage`, so a limit
 * found mid-chain defers the remaining candidates on that lane.
 */
export function isDemotedForQuota(
  model: ChatModel,
  aiCreditsRoutingMode: AiCreditsRoutingMode | undefined,
): boolean {
  const provider = getProviderForModel(model);
  if (provider !== 'claude' && provider !== 'codex') {
    return false;
  }
  if (!isProviderQuotaReached(provider)) {
    return false;
  }
  // A gateway-routable model keeps its slot only when the user's AI Credits
  // routing can carry it past the exhausted native lane. Under `off` (the
  // normalized default) nothing reroutes it.
  const gatewayCarries =
    aiCreditsRoutingMode === 'on' || aiCreditsRoutingMode === 'on-quota';
  return !(gatewayCarries && isGatewayRoutableModel(model));
}

/**
 * Resolve the ordered commit-message model chain. Performs no network I/O;
 * stored-policy reads are the only async work.
 */
export async function resolveCommitGenerationModelCandidates(
  input: ResolveCommitGenerationModelCandidatesInput,
): Promise<CommitGenerationModelPlan> {
  // Callers resolve this outside their per-repo error handling, so it must
  // never reject: any failure degrades to the configured model alone.
  const aiCreditsRoutingMode = input.preferences.aiCreditsRoutingMode;
  try {
    return { ...(await resolveCandidates(input)), aiCreditsRoutingMode };
  } catch (error) {
    logMainProcessWarn(
      `[commit-message] Could not resolve fallback commit models: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      model: input.primaryModel,
      fallbackModels: [],
      aiCreditsRoutingMode,
    };
  }
}

async function resolveCandidates(
  input: ResolveCommitGenerationModelCandidatesInput,
): Promise<CommitGenerationModelPlan> {
  // A local primary was chosen to keep the diff on this machine: never fall
  // back to a hosted model. It is attempted as-is (Ollama ids register only
  // after discovery, so it must not be filtered as unknown).
  const configuredPrimary: ChatModel = input.primaryModel;
  if (isOllamaModel(input.primaryModel)) {
    return { model: input.primaryModel, fallbackModels: [] };
  }

  // Dedupe on the canonical id so an alias and its target never take two
  // slots; unknown ids are dropped here too.
  const known: ChatModel[] = [];
  const seen = new Set<ChatModel>();
  for (const model of collectCandidates(input)) {
    const canonical = resolveKnownModel(model);
    if (canonical !== undefined && !seen.has(canonical)) {
      seen.add(canonical);
      known.push(model);
    }
  }
  if (!known.includes(configuredPrimary)) {
    logMainProcessWarn(
      `[commit-message] Configured commit model ${configuredPrimary} is not a known model; using fallback candidates.`,
    );
  }

  let allowed = known;
  if (!isStoredModelPolicyReadDegraded()) {
    // Scoped to the same owner the per-attempt gate uses. An unresolvable
    // owner falls back to the owner-less read rather than throwing here.
    const workOwner = await resolveHelperWorkOwner({
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    }).catch(() => undefined);
    // The primary is left to the per-attempt gate, so a blocked configured
    // model still records its refusal before the chain advances.
    const blocked = await Promise.all(
      known.map((model) =>
        model === input.primaryModel
          ? Promise.resolve(false)
          : isModelBlockedByStoredPolicy(model, workOwner),
      ),
    );
    allowed = known.filter((_model, index) => !blocked[index]);
  }

  const routingMode = input.preferences.aiCreditsRoutingMode;
  const preferred = allowed.filter(
    (model) => !isDemotedForQuota(model, routingMode),
  );
  const demoted = allowed.filter((model) =>
    isDemotedForQuota(model, routingMode),
  );
  const ranked = [...preferred, ...demoted];
  const ordered = ranked.slice(0, MAX_COMMIT_GENERATION_MODEL_CANDIDATES);
  // Trailing lane members routinely fall past the cap; only a dropped
  // configured model is worth a warning.
  if (
    ranked.indexOf(configuredPrimary) >= MAX_COMMIT_GENERATION_MODEL_CANDIDATES
  ) {
    logMainProcessWarn(
      `[commit-message] Configured commit model ${configuredPrimary} was quota-demoted past the candidate cap and will not be attempted.`,
    );
  }

  const [model, ...fallbackModels] = ordered;
  // Nothing survived filtering (the primary is unknown and every fallback was
  // dropped): hand back the primary so its attempt is logged and skipped
  // before the branch-title fallback, rather than returning an empty plan.
  if (model === undefined) {
    return { model: input.primaryModel, fallbackModels: [] };
  }
  return { model, fallbackModels };
}
