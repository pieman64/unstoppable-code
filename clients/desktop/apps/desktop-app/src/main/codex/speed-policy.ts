/**
 * Main-process Codex speed admission policy.
 *
 * Callers pass the TRUSTED facts of the invocation they are about to run —
 * the resolved model, execution harness, provider, AI Credits / organization
 * gateway routing, thread-level provider config, and the environment overlay
 * applied to the Codex process — never renderer-supplied route hints or a
 * provider nickname. This module classifies those facts into
 * {@link CodexSpeedRouteFacts} and admits the exact requested speed through
 * `assertCodexSpeedAvailable` before any side effect.
 *
 * Regular and Fast are never gated (no catalog read). Ultra fast needs a
 * route the Codex `model/list` catalog describes: the native Codex sign-in
 * (the same canonical user state and credential the catalog was read from,
 * with no gateway, Ollama, Cursor, user-supplied provider credential/redirect,
 * or thread provider override), or the account proxy's own provider block,
 * where the proxy's own Codex catalog must advertise the tier as well. Nothing
 * here downgrades, switches billing lanes, replays, or probes.
 */
import {
  CodexSpeedUnsupportedError,
  DEFAULT_CODEX_SPEED,
  readCodexSpeedRecord,
  type CodexSpeed,
} from '@canopy/desktop-shared/lib/codex-speed';
import {
  classifyCodexSpeedRejection,
  describeCodexSpeedAvailability,
  type CodexSpeedRouteFacts,
  type CodexSpeedRouteProfile,
} from '@canopy/desktop-shared/lib/codex-speed-availability';
import {
  codexServiceTierForModelConfig,
  type CodexServiceTier,
} from '@canopy/desktop-shared/lib/codex-model-config';
import {
  getModelSource,
  resolveModelAlias,
  type AgentModelConfig,
  type AgentProviderType,
  type ModelHarness,
  type ModelHarnessSource,
} from '@canopy/desktop-shared/types';
import {
  assertCodexSpeedAvailable,
  reportCodexSpeedRejection,
  type CodexSpeedAdmission,
} from '../model-routing/codex-account-models';
import { ACCOUNT_PROXY_CODEX_PROVIDER_ID } from '../account-proxy/codex-provider';

export type { CodexSpeedAdmission };

/**
 * Environment keys that make a Codex process authenticate or send its
 * requests somewhere other than the canonical native sign-in: a user-supplied
 * OpenAI credential, or a redirect of the built-in provider. They are route
 * facts, not an entitlement list; blank values are ignored.
 */
const FOREIGN_CODEX_ENVIRONMENT_KEYS: readonly string[] = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_BASE_URL',
];

/** The trusted, host-resolved facts of one Codex invocation. */
export interface CodexSpeedRouteEvidence {
  /** `auto` when Auto routing picks the model. Defaults to `explicit`. */
  modelSelection?: 'explicit' | 'auto';
  /** Local catalog model the user selected; drives the model source. */
  selectedModel?: string | null;
  /** Model identity actually sent to Codex (alias, runtime, gateway id). */
  runtimeModel?: string | null;
  /**
   * Catalog source of the selected model when the caller already resolved
   * it (for example a helper invocation); otherwise derived from the model.
   */
  modelSource?: ModelHarnessSource | null;
  /** Actual execution harness. */
  harness: ModelHarness | null | undefined;
  /** Provider the invocation actually runs (Ollama runs the Codex harness). */
  providerType?: AgentProviderType | null;
  /** AI Credits or organization gateway routing actually applied. */
  gateway?: 'ai-credits' | 'org-gateway' | null;
  /** Thread-level provider config actually applied to the invocation. */
  codexConfig?: Readonly<Record<string, unknown>> | null;
  /**
   * Environment overlay applied to the Codex process (Canopy Environments
   * plus invocation overrides), excluding the deterministic E2E mock env.
   */
  environment?: Readonly<Record<string, string | undefined>> | null;
  /** The deterministic E2E mock app-server provider is in use. */
  mockProvider?: boolean;
  /** The caller cannot yet tell which route will run. */
  unresolvedRoute?: boolean;
}

function hasForeignEnvironment(
  environment: CodexSpeedRouteEvidence['environment'],
): boolean {
  if (!environment) return false;
  return FOREIGN_CODEX_ENVIRONMENT_KEYS.some(
    (key) => (environment[key] ?? '').trim().length > 0,
  );
}

function isProviderKey(key: string): boolean {
  return (
    key === 'model_provider' ||
    key === 'model_providers' ||
    key.startsWith('model_providers.')
  );
}

function hasProviderOverride(
  config: CodexSpeedRouteEvidence['codexConfig'],
): boolean {
  if (!config) return false;
  return Object.keys(config).some(isProviderKey);
}

/**
 * The account proxy's provider block and nothing else: it selects the proxy
 * provider and defines no other provider.
 */
function isAccountProxyProviderConfig(
  config: CodexSpeedRouteEvidence['codexConfig'],
): boolean {
  if (!config || config.model_provider !== ACCOUNT_PROXY_CODEX_PROVIDER_ID) {
    return false;
  }
  const providers = config.model_providers;
  if (
    providers !== undefined &&
    (typeof providers !== 'object' ||
      providers === null ||
      Object.keys(providers).some(
        (id) => id !== ACCOUNT_PROXY_CODEX_PROVIDER_ID,
      ))
  ) {
    return false;
  }
  return Object.keys(config).every(
    (key) =>
      !isProviderKey(key) ||
      key === 'model_provider' ||
      key === 'model_providers' ||
      key.startsWith(`model_providers.${ACCOUNT_PROXY_CODEX_PROVIDER_ID}.`),
  );
}

function resolveEvidenceModelSource(
  evidence: CodexSpeedRouteEvidence,
): ModelHarnessSource | null {
  if (evidence.modelSource !== undefined) return evidence.modelSource;
  return evidence.selectedModel
    ? (getModelSource(evidence.selectedModel) ?? null)
    : null;
}

/** Classify how an invocation actually reaches its model. */
export function classifyCodexSpeedRouteProfile(
  evidence: CodexSpeedRouteEvidence,
): CodexSpeedRouteProfile {
  if (evidence.harness === 'cursor' || evidence.providerType === 'cursor') {
    return 'cursor';
  }
  if (
    evidence.providerType === 'ollama' ||
    resolveEvidenceModelSource(evidence) === 'ollama'
  ) {
    return 'ollama';
  }
  if (evidence.gateway) return evidence.gateway;
  if (evidence.unresolvedRoute) return 'unknown';
  if (evidence.harness !== 'codex') return 'foreign';
  // The proxy's provider block routes the thread even under the E2E mock
  // provider, whose runtime catalog it is still checked against.
  if (isAccountProxyProviderConfig(evidence.codexConfig)) {
    return hasForeignEnvironment(evidence.environment)
      ? 'foreign'
      : 'account-proxy';
  }
  // The E2E mock provider is paired with the mock `model/list` the catalog
  // reads under the same flag, so its catalog describes this exact route.
  if (evidence.mockProvider) return 'codex-native';
  if (hasForeignEnvironment(evidence.environment)) return 'foreign';
  if (hasProviderOverride(evidence.codexConfig)) return 'foreign';
  return 'codex-native';
}

/** Project trusted evidence into the shared availability route facts. */
export function buildCodexSpeedRouteFacts(
  evidence: CodexSpeedRouteEvidence,
): CodexSpeedRouteFacts {
  const selected = evidence.selectedModel ?? null;
  const runtimeModel = evidence.runtimeModel ?? selected;
  const equivalentModels: string[] = [];
  for (const candidate of selected
    ? [selected, resolveModelAlias(selected)]
    : []) {
    if (candidate !== runtimeModel && !equivalentModels.includes(candidate)) {
      equivalentModels.push(candidate);
    }
  }
  return {
    modelSelection: evidence.modelSelection ?? 'explicit',
    runtimeModel,
    equivalentModels,
    modelSource: resolveEvidenceModelSource(evidence),
    harness: evidence.harness ?? null,
    routeProfile: classifyCodexSpeedRouteProfile(evidence),
  };
}

/**
 * Admit the exact requested speed for the invocation described by
 * `evidence`. Regular and Fast resolve immediately. Ultra fast resolves only
 * when the catalog advertises it for the actual model on this route and no
 * denial for the route applies; otherwise this throws a `CodexSpeedUnsupportedError` (never a
 * substitute speed).
 */
export function admitCodexSpeed(
  speed: CodexSpeed,
  evidence: CodexSpeedRouteEvidence,
): Promise<CodexSpeedAdmission> {
  return assertCodexSpeedAvailable({
    speed,
    route: buildCodexSpeedRouteFacts(evidence),
  });
}

/**
 * Service tier for metadata-only thread lifecycle requests (start, resume,
 * fork) that precede an admitted turn. Regular and Fast keep their exact
 * tier. Ultra fast sends an explicit `default` so a thread never persists an
 * unadmitted Ultra fast tier; each admitted `turn/start` carries the exact
 * tier. The canonical requested speed itself is unchanged.
 */
export function codexLifecycleServiceTier(
  config: Pick<AgentModelConfig, 'speed' | 'fastMode'> | null | undefined,
): CodexServiceTier {
  const tier = codexServiceTierForModelConfig(config);
  return tier === 'ultrafast' ? 'default' : tier;
}

const UNCONFIRMED_ULTRAFAST_MESSAGE =
  "Couldn't confirm Ultra fast for this model. Try again, or choose Regular or Fast.";

/**
 * Fail-closed guard at the request boundary: an Ultra fast `turn/start` may
 * be sent only when the caller admitted Ultra fast for that exact turn.
 * Throws before any app-server request; Regular and Fast always pass.
 */
export function assertCodexTurnSpeedAdmitted(
  config: Pick<AgentModelConfig, 'speed' | 'fastMode'> | null | undefined,
  ultrafastAdmitted: boolean,
): void {
  if (codexServiceTierForModelConfig(config) !== 'ultrafast') return;
  if (ultrafastAdmitted) return;
  throw new CodexSpeedUnsupportedError(
    'ultrafast',
    UNCONFIRMED_ULTRAFAST_MESSAGE,
  );
}

/**
 * The Codex speed an Auto-routed turn would run with if routing picked a
 * Codex model: the request's own record (plus legacy alias), then the tab's
 * retained Codex speed while it runs another provider, then the Codex default.
 */
export function resolveAutoRoutingCodexSpeed(input: {
  requestModelConfig?: AgentModelConfig | null;
  requestCodexFastModeEnabled?: boolean | null;
  tab?: {
    providerType?: AgentProviderType | null;
    modelConfig?: AgentModelConfig | null;
    codexFastModeEnabled?: boolean | null;
    retainedCodexSpeed?: CodexSpeed | null;
  } | null;
  defaults?: Partial<Record<AgentProviderType, AgentModelConfig>> | null;
}): CodexSpeed {
  const tab = input.tab ?? undefined;
  const tabIsCodex = tab?.providerType === 'codex';
  return (
    readCodexSpeedRecord(
      input.requestModelConfig,
      input.requestCodexFastModeEnabled,
    ) ??
    (tabIsCodex
      ? readCodexSpeedRecord(tab?.modelConfig, tab?.codexFastModeEnabled)
      : (tab?.retainedCodexSpeed ?? undefined)) ??
    readCodexSpeedRecord(input.defaults?.codex) ??
    DEFAULT_CODEX_SPEED
  );
}

/**
 * Auto routing cannot honor Ultra fast in this release: it must not pick a
 * model (or spend a routing decision) that may not offer the tier. Rejects
 * before routing; Regular and Fast pass.
 */
export function assertAutoRoutingCodexSpeed(speed: CodexSpeed): void {
  if (speed !== 'ultrafast') return;
  throw new CodexSpeedUnsupportedError(
    speed,
    describeCodexSpeedAvailability({
      speed,
      status: 'unavailable',
      reason: 'auto-model',
      generation: null,
    }) ??
      'Ultra fast needs a specific model. Choose a model that offers Ultra fast, or choose Regular or Fast.',
  );
}

/**
 * Gateway kind for an interactive session that applied AI Credits routing:
 * an organization-gateway catalog entry routes through that gateway,
 * everything else through AI Credits. Neither is the native route.
 */
export function codexSpeedGatewayForOrigin(
  origin: string | null | undefined,
): 'ai-credits' | 'org-gateway' {
  return origin === 'org-gateway' ? 'org-gateway' : 'ai-credits';
}

/** `TurnError`-shaped failure of an admitted request. */
export interface CodexSpeedTurnFailure {
  codexErrorInfo?: unknown;
  message?: string;
}

/**
 * Report ONE failed real request made under an Ultra fast admission. Only a
 * definitive model/tier/access rejection in the admitted catalog generation
 * records a temporary denial; everything else stays retryable. Never replays
 * or switches speed.
 *
 * @returns whether a denial was recorded
 */
export function reportCodexSpeedTurnFailure(
  admission: CodexSpeedAdmission | undefined,
  runtimeModel: string | null | undefined,
  failure: CodexSpeedTurnFailure,
): boolean {
  if (!admission || admission.speed !== 'ultrafast' || !runtimeModel) {
    return false;
  }
  return reportCodexSpeedRejection({
    speed: admission.speed,
    runtimeModel,
    kind: classifyCodexSpeedRejection(failure),
    generation: admission.generation,
    routeProfile: admission.routeProfile,
  });
}
