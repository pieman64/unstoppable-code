/**
 * Pure, browser-safe Codex speed availability derivation shared by desktop
 * main (dispatch admission) and the renderer (speed selectors).
 *
 * Inputs are the sanitized {@link CodexSpeedCatalog} projection plus the
 * ACTUAL route facts of the turn. Nothing here reads host state, account
 * identity, paths, or secrets. Model names and account plans are never used as
 * allowlists: a model is eligible for Ultra fast only when the Codex runtime's
 * `model/list` catalog advertises the `ultrafast` service tier for it (Codex
 * drops any tier its own catalog does not list), on a route that catalog
 * describes. The account proxy route must ALSO be advertised by the proxy's
 * own catalog (`routes['account-proxy']`); without it Ultra fast is unknown.
 *
 * Regular and Fast are never gated by this module; they keep their existing
 * behavior whether or not tier metadata is available.
 */
import type { CodexSpeed } from './codex-speed';
import type {
  CodexSpeedCatalog,
  CodexSpeedCatalogDenial,
  CodexSpeedCatalogModel,
  CodexSpeedRouteCatalog,
  CodexSpeedTierSource,
} from '../types/codex-speed-capabilities';
import type {
  ModelHarness,
  ModelHarnessSource,
} from '../types/model-harnesses';

/** Positive and negative catalog results are both revalidated after this. */
export const CODEX_SPEED_CATALOG_TTL_MS = 5 * 60_000;

/** A definitive tier rejection hides Ultra fast for at most this long. */
export const CODEX_SPEED_DENIAL_TTL_MS = 5 * 60_000;

/** Service-tier IDs retained in the catalog projection; others are ignored. */
export type CodexKnownServiceTierId = 'priority' | 'ultrafast';

const MAX_CATALOG_MODELS = 2_000;
const MAX_CATALOG_DENIALS = 2_000;
const MAX_CATALOG_STRING_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize one advertised tier ID. The deprecated `fast` alias is the same
 * tier as `priority`; unknown IDs return `null` and are ignored.
 */
export function normalizeCodexServiceTierId(
  id: unknown,
): CodexKnownServiceTierId | null {
  if (typeof id !== 'string') return null;
  const normalized = id.trim().toLowerCase();
  if (normalized === 'priority' || normalized === 'fast') return 'priority';
  if (normalized === 'ultrafast') return 'ultrafast';
  return null;
}

function normalizeTierList(entries: readonly unknown[]): string[] {
  const tiers: string[] = [];
  for (const entry of entries) {
    const id = normalizeCodexServiceTierId(isRecord(entry) ? entry.id : entry);
    if (id && !tiers.includes(id)) tiers.push(id);
  }
  return tiers;
}

/**
 * Read the advertised tiers of one native `model/list` entry.
 *
 * - `serviceTiers` is authoritative whenever it is an array, EVEN WHEN EMPTY.
 * - The deprecated `additionalSpeedTiers` is used only when the modern field
 *   is missing.
 * - Neither field present means unknown (`tiers: null`), which is distinct
 *   from an empty authoritative list.
 */
export function readCodexModelSpeedTiers(entry: unknown): {
  tiers: string[] | null;
  source: CodexSpeedTierSource;
} {
  if (!isRecord(entry)) return { tiers: null, source: 'unknown' };
  if (Array.isArray(entry.serviceTiers)) {
    return {
      tiers: normalizeTierList(entry.serviceTiers),
      source: 'serviceTiers',
    };
  }
  // A present but malformed modern field cannot be replaced with legacy
  // advertising. Only an absent field permits the compatibility fallback.
  if (entry.serviceTiers !== undefined) {
    return { tiers: null, source: 'unknown' };
  }
  if (Array.isArray(entry.additionalSpeedTiers)) {
    return {
      tiers: normalizeTierList(entry.additionalSpeedTiers),
      source: 'additionalSpeedTiers',
    };
  }
  return { tiers: null, source: 'unknown' };
}

/**
 * Project one native `model/list` entry into the sanitized catalog shape.
 * Returns `null` when the entry names no model.
 */
export function parseCodexSpeedCatalogModel(
  entry: unknown,
): CodexSpeedCatalogModel | null {
  if (!isRecord(entry)) return null;
  const id = typeof entry.id === 'string' && entry.id ? entry.id : null;
  const model =
    typeof entry.model === 'string' && entry.model ? entry.model : null;
  if (!id && !model) return null;
  const { tiers, source } = readCodexModelSpeedTiers(entry);
  return { id: id ?? model ?? '', model: model ?? id ?? '', tiers, source };
}

/**
 * Project one entry of Codex's own `/models` wire catalog (snake_case, as a
 * provider such as CLIProxyAPI serves it) into the sanitized catalog shape,
 * with the same tier rules as {@link readCodexModelSpeedTiers}.
 */
export function parseCodexSpeedCatalogWireModel(
  entry: unknown,
): CodexSpeedCatalogModel | null {
  if (!isRecord(entry)) return null;
  const slug = typeof entry.slug === 'string' && entry.slug ? entry.slug : null;
  if (!slug) return null;
  const { tiers, source } = readCodexModelSpeedTiers({
    serviceTiers: entry.service_tiers,
    additionalSpeedTiers: entry.additional_speed_tiers,
  });
  return { id: slug, model: slug, tiers, source };
}

/** A catalog with no usable data for the given generation. */
export function createUnknownCodexSpeedCatalog(
  generation = 0,
): CodexSpeedCatalog {
  return {
    generation,
    status: 'unknown',
    fetchedAt: null,
    expiresAt: null,
    truncated: false,
    models: [],
    denials: [],
  };
}

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CATALOG_STRING_LENGTH
  );
}

function isNullableTimestamp(value: unknown): value is number | null {
  return (
    value === null || (typeof value === 'number' && Number.isFinite(value))
  );
}

function isTierSource(value: unknown): value is CodexSpeedTierSource {
  return (
    value === 'serviceTiers' ||
    value === 'additionalSpeedTiers' ||
    value === 'unknown'
  );
}

function isCatalogModel(value: unknown): value is CodexSpeedCatalogModel {
  if (!isRecord(value)) return false;
  if (!isBoundedString(value.id) || !isBoundedString(value.model)) {
    return false;
  }
  if (!isTierSource(value.source)) return false;
  if (value.tiers === null) return true;
  return (
    Array.isArray(value.tiers) &&
    value.tiers.length <= 32 &&
    value.tiers.every((tier) => isBoundedString(tier))
  );
}

function isRouteCatalog(value: unknown): value is CodexSpeedRouteCatalog {
  return (
    isRecord(value) &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    (value.status === 'ready' || value.status === 'unknown') &&
    isNullableTimestamp(value.fetchedAt) &&
    isNullableTimestamp(value.expiresAt) &&
    typeof value.truncated === 'boolean' &&
    Array.isArray(value.models) &&
    value.models.length <= MAX_CATALOG_MODELS &&
    value.models.every(isCatalogModel) &&
    (value.error === undefined ||
      (typeof value.error === 'string' &&
        value.error.length <= MAX_CATALOG_STRING_LENGTH))
  );
}

function isRouteCatalogs(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === 'account-proxy') &&
    (value['account-proxy'] === undefined ||
      isRouteCatalog(value['account-proxy']))
  );
}

function isCatalogDenial(value: unknown): value is CodexSpeedCatalogDenial {
  return (
    isRecord(value) &&
    isBoundedString(value.model) &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    (value.route === undefined || value.route === 'account-proxy')
  );
}

/** Structural validation for catalogs crossing the IPC boundary. */
export function isCodexSpeedCatalog(
  value: unknown,
): value is CodexSpeedCatalog {
  if (!isRecord(value)) return false;
  return (
    typeof value.generation === 'number' &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 0 &&
    (value.status === 'ready' || value.status === 'unknown') &&
    isNullableTimestamp(value.fetchedAt) &&
    isNullableTimestamp(value.expiresAt) &&
    typeof value.truncated === 'boolean' &&
    Array.isArray(value.models) &&
    value.models.length <= MAX_CATALOG_MODELS &&
    value.models.every(isCatalogModel) &&
    Array.isArray(value.denials) &&
    value.denials.length <= MAX_CATALOG_DENIALS &&
    value.denials.every(isCatalogDenial) &&
    (value.error === undefined ||
      (typeof value.error === 'string' &&
        value.error.length <= MAX_CATALOG_STRING_LENGTH)) &&
    (value.routes === undefined || isRouteCatalogs(value.routes))
  );
}

/**
 * Order catalogs by generation, then by `fetchedAt`, then by the account
 * proxy catalog's `revision` (absent sorts first). Negative when `a` is older
 * than `b`, zero when equally ordered.
 */
export function compareCodexSpeedCatalogOrder(
  a: CodexSpeedCatalog,
  b: CodexSpeedCatalog,
): number {
  if (a.generation !== b.generation) return a.generation - b.generation;
  const native = (a.fetchedAt ?? -1) - (b.fetchedAt ?? -1);
  if (native !== 0) return native;
  return (
    (a.routes?.['account-proxy']?.revision ?? -1) -
    (b.routes?.['account-proxy']?.revision ?? -1)
  );
}

/**
 * Whether a mirror holding `current` should adopt `next`. Older generations
 * and older fetches are rejected; an equally ordered catalog replaces the
 * current one (for example a denial or failure update in the same fetch).
 */
export function shouldAcceptCodexSpeedCatalog(
  current: CodexSpeedCatalog | null,
  next: CodexSpeedCatalog,
): boolean {
  return current === null || compareCodexSpeedCatalogOrder(next, current) >= 0;
}

/**
 * How a Codex turn actually reaches its model.
 *
 * - `codex-native`: the Codex harness on the native canonical Codex sign-in
 *   (the same runtime profile and credential store the catalog was read
 *   from), with no AI Credits/organization gateway provider, no Ollama or
 *   mock provider, and no user-supplied provider credential or redirect.
 * - `account-proxy`: the Codex harness on the account proxy's provider block,
 *   which serves the same Codex models from the proxy's Codex (ChatGPT)
 *   accounts, so the `model/list` tiers apply to it too.
 * - `ai-credits` / `org-gateway`: routed through a gateway; the native catalog
 *   proves nothing about it.
 * - `ollama` / `cursor` / `foreign`: another provider or credential.
 * - `unknown`: the caller cannot yet tell which route will run.
 */
export type CodexSpeedRouteProfile =
  | 'codex-native'
  | 'account-proxy'
  | 'ai-credits'
  | 'org-gateway'
  | 'ollama'
  | 'cursor'
  | 'foreign'
  | 'unknown';

/** The actual route/model facts a speed is evaluated against. */
export interface CodexSpeedRouteFacts {
  /** `auto` when Auto routing picks the model; Ultra fast needs `explicit`. */
  modelSelection: 'explicit' | 'auto';
  /** Resolved runtime model sent to Codex, or null when unresolved. */
  runtimeModel: string | null;
  /**
   * Equivalent identities (canonical alias, agent base model) tried in order
   * after `runtimeModel`. Resolution comes from the model catalog, never a
   * name or plan allowlist.
   */
  equivalentModels?: readonly string[];
  /** Actual catalog source of the resolved model. */
  modelSource: ModelHarnessSource | null;
  /** Actual execution harness. */
  harness: ModelHarness | null;
  routeProfile: CodexSpeedRouteProfile;
}

export type CodexSpeedAvailabilityStatus =
  | 'available'
  | 'unavailable'
  | 'unknown';

export type CodexSpeedAvailabilityReason =
  /** Regular and Fast are never gated here. */
  | 'not-gated'
  /** The matched model advertises `ultrafast`. */
  | 'advertised'
  | 'route-not-native'
  | 'route-unknown'
  | 'auto-model'
  | 'no-model'
  | 'catalog-unknown'
  | 'catalog-truncated'
  | 'model-ambiguous'
  | 'model-unlisted'
  | 'tiers-unknown'
  | 'not-advertised'
  | 'denied';

export interface CodexSpeedAvailability {
  speed: CodexSpeed;
  status: CodexSpeedAvailabilityStatus;
  reason: CodexSpeedAvailabilityReason;
  /** Catalog generation the result was derived from, when a catalog exists. */
  generation: number | null;
}

export type CodexSpeedCatalogMatch =
  | { kind: 'match'; model: CodexSpeedCatalogModel }
  | { kind: 'conflict' }
  | { kind: 'none' };

function sameTiers(
  left: CodexSpeedCatalogModel,
  right: CodexSpeedCatalogModel,
): boolean {
  if (left.tiers === null || right.tiers === null) {
    return left.tiers === right.tiers;
  }
  if (left.tiers.length !== right.tiers.length) return false;
  const rightTiers = right.tiers;
  return left.tiers.every((tier) => rightTiers.includes(tier));
}

function pickConsistent(
  entries: readonly CodexSpeedCatalogModel[],
): CodexSpeedCatalogMatch {
  const [first, ...rest] = entries;
  if (!first) return { kind: 'none' };
  return rest.every((entry) => sameTiers(first, entry))
    ? { kind: 'match', model: first }
    : { kind: 'conflict' };
}

function candidateModels(route: CodexSpeedRouteFacts): string[] {
  const candidates: string[] = [];
  for (const candidate of [
    route.runtimeModel,
    ...(route.equivalentModels ?? []),
  ]) {
    if (candidate && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * Find the catalog entry for the resolved model. Each candidate is matched
 * against the catalog `model` field first, then `id`; entries that disagree
 * about their tiers are a conflict (unknown), never a guess.
 */
export function matchCodexSpeedCatalogModel(
  catalog: Pick<CodexSpeedCatalog, 'models'>,
  candidates: readonly string[],
): CodexSpeedCatalogMatch {
  for (const candidate of candidates) {
    const byModel = pickConsistent(
      catalog.models.filter((entry) => entry.model === candidate),
    );
    if (byModel.kind !== 'none') return byModel;
    const byId = pickConsistent(
      catalog.models.filter((entry) => entry.id === candidate),
    );
    if (byId.kind !== 'none') return byId;
  }
  return { kind: 'none' };
}

/** Route profiles the Codex `model/list` catalog describes. */
export function isCodexSpeedCatalogRouteProfile(
  profile: CodexSpeedRouteProfile | null | undefined,
): profile is 'codex-native' | 'account-proxy' {
  return profile === 'codex-native' || profile === 'account-proxy';
}

/** True when the route can use the Codex `model/list` catalog at all. */
export function isCodexSpeedRouteCatalogBacked(
  route: CodexSpeedRouteFacts,
): boolean {
  return (
    route.modelSource === 'codex-managed' &&
    route.harness === 'codex' &&
    isCodexSpeedCatalogRouteProfile(route.routeProfile)
  );
}

/**
 * Denials are kept per route: an account proxy account that refuses a tier
 * says nothing about the native sign-in, and the reverse.
 */
function isDenied(
  denials: readonly CodexSpeedCatalogDenial[],
  models: readonly string[],
  routeProfile: CodexSpeedRouteProfile,
  now: number,
): boolean {
  const route = routeProfile === 'account-proxy' ? 'account-proxy' : undefined;
  return denials.some(
    (denial) =>
      denial.expiresAt > now &&
      denial.route === route &&
      models.includes(denial.model),
  );
}

interface TierCheck {
  status: CodexSpeedAvailabilityStatus;
  reason: CodexSpeedAvailabilityReason;
  /** The matched entry, when the catalog lists the model. */
  model?: CodexSpeedCatalogModel;
}

/** Whether one catalog advertises Ultra fast for the first matching model. */
function checkUltrafastTier(
  catalog:
    | Pick<CodexSpeedRouteCatalog, 'status' | 'truncated' | 'models'>
    | null
    | undefined,
  candidates: readonly string[],
): TierCheck {
  if (!catalog || catalog.status !== 'ready') {
    return { status: 'unknown', reason: 'catalog-unknown' };
  }
  const match = matchCodexSpeedCatalogModel(catalog, candidates);
  if (match.kind === 'conflict') {
    return { status: 'unknown', reason: 'model-ambiguous' };
  }
  if (match.kind === 'none') {
    return catalog.truncated
      ? { status: 'unknown', reason: 'catalog-truncated' }
      : { status: 'unavailable', reason: 'model-unlisted' };
  }
  const model = match.model;
  if (model.tiers === null) {
    return { status: 'unknown', reason: 'tiers-unknown', model };
  }
  return model.tiers.includes('ultrafast')
    ? { status: 'available', reason: 'advertised', model }
    : { status: 'unavailable', reason: 'not-advertised', model };
}

/**
 * Both checks must pass: a definite refusal from either wins, then an
 * unconfirmed one; the runtime catalog's answer comes first.
 */
function combineTierChecks(runtime: TierCheck, route: TierCheck): TierCheck {
  if (runtime.status === 'unavailable') return runtime;
  if (route.status === 'unavailable') return route;
  if (runtime.status === 'unknown') return runtime;
  if (route.status === 'unknown') return route;
  return runtime;
}

export interface DeriveCodexSpeedAvailabilityInput {
  catalog: CodexSpeedCatalog | null;
  route: CodexSpeedRouteFacts;
  speed: CodexSpeed;
  /** Epoch milliseconds used to expire denials. */
  now: number;
}

/**
 * Derive whether `speed` can run on the given route. Regular and Fast are
 * always `available` (existing behavior). Ultra fast is `available` only when
 * the runtime catalog advertises `ultrafast` for the resolved model on a
 * route it describes, the account proxy route's own catalog advertises it
 * too, and no unexpired denial for that route applies; missing metadata is
 * `unknown`.
 */
export function deriveCodexSpeedAvailability(
  input: DeriveCodexSpeedAvailabilityInput,
): CodexSpeedAvailability {
  const { catalog, route, speed, now } = input;
  const generation = catalog ? catalog.generation : null;
  const result = (
    status: CodexSpeedAvailabilityStatus,
    reason: CodexSpeedAvailabilityReason,
  ): CodexSpeedAvailability => ({ speed, status, reason, generation });

  if (speed !== 'ultrafast') return result('available', 'not-gated');
  if (!isCodexSpeedRouteCatalogBacked(route)) {
    const nativeShaped =
      route.modelSource === 'codex-managed' && route.harness === 'codex';
    return nativeShaped && route.routeProfile === 'unknown'
      ? result('unknown', 'route-unknown')
      : result('unavailable', 'route-not-native');
  }
  if (route.modelSelection === 'auto') {
    return result('unavailable', 'auto-model');
  }
  const candidates = candidateModels(route);
  if (candidates.length === 0) return result('unavailable', 'no-model');
  const runtime = checkUltrafastTier(catalog, candidates);
  if (
    catalog &&
    runtime.model &&
    isDenied(
      catalog.denials,
      [...candidates, runtime.model.model, runtime.model.id],
      route.routeProfile,
      now,
    )
  ) {
    return result('unavailable', 'denied');
  }
  const checked =
    route.routeProfile === 'account-proxy'
      ? combineTierChecks(
          runtime,
          checkUltrafastTier(catalog?.routes?.['account-proxy'], candidates),
        )
      : runtime;
  return result(checked.status, checked.reason);
}

/** Availability of every speed for one route, e.g. for a full picker. */
export function deriveCodexSpeedOptions(
  input: Omit<DeriveCodexSpeedAvailabilityInput, 'speed'>,
): Record<CodexSpeed, CodexSpeedAvailability> {
  return {
    standard: deriveCodexSpeedAvailability({ ...input, speed: 'standard' }),
    fast: deriveCodexSpeedAvailability({ ...input, speed: 'fast' }),
    ultrafast: deriveCodexSpeedAvailability({ ...input, speed: 'ultrafast' }),
  };
}

/**
 * User-facing explanation for a speed that cannot run, or `null` when it
 * can. At most two sentences, always naming an alternative.
 */
export function describeCodexSpeedAvailability(
  availability: CodexSpeedAvailability,
): string | null {
  if (availability.status === 'available') return null;
  switch (availability.reason) {
    case 'route-not-native':
      return 'Ultra fast runs only on a Codex sign-in. Choose Regular or Fast for this connection.';
    case 'auto-model':
    case 'no-model':
      return 'Ultra fast needs a specific model. Choose a model that offers Ultra fast, or choose Regular or Fast.';
    case 'model-unlisted':
    case 'not-advertised':
      return "This Codex connection doesn't offer Ultra fast for this model. Choose Regular or Fast.";
    case 'denied':
      return 'Codex recently declined Ultra fast for this model. Choose Regular or Fast, or try again later.';
    case 'route-unknown':
    case 'catalog-unknown':
    case 'catalog-truncated':
    case 'model-ambiguous':
    case 'tiers-unknown':
    case 'not-gated':
    case 'advertised':
      return "Couldn't confirm Ultra fast for this model. Try again, or choose Regular or Fast.";
  }
}

/**
 * Conservative classification of a failed Codex request made at a speed.
 * Only a definitive model/tier/access rejection may become a temporary
 * denial; authentication, network, rate-limit, and capacity failures never do.
 */
export type CodexSpeedRejectionKind =
  | 'model'
  | 'tier'
  | 'access'
  | 'auth'
  | 'network'
  | 'rate-limit'
  | 'capacity'
  | 'unknown';

/** Whether a rejection kind is a definitive entitlement signal. */
export function isDefinitiveCodexSpeedRejection(
  kind: CodexSpeedRejectionKind,
): boolean {
  return kind === 'model' || kind === 'tier' || kind === 'access';
}

const TIER_REJECTION_PATTERN = /\b(service[\s_-]?tier|ultra[\s_-]?fast)\b/i;

/**
 * Classify a Codex turn error (`TurnError`-shaped: `codexErrorInfo` plus
 * `message`). A `badRequest` counts as a tier rejection only when its message
 * names the service tier; everything ambiguous is `unknown`.
 */
export function classifyCodexSpeedRejection(
  error: unknown,
): CodexSpeedRejectionKind {
  if (!isRecord(error)) return 'unknown';
  const info = error.codexErrorInfo;
  const message = typeof error.message === 'string' ? error.message : '';
  if (info === 'unauthorized') return 'auth';
  if (info === 'rateLimitExceeded' || info === 'usageLimitExceeded') {
    return 'rate-limit';
  }
  if (info === 'serverOverloaded' || info === 'flexUnavailable') {
    return 'capacity';
  }
  if (
    isRecord(info) &&
    ('httpConnectionFailed' in info ||
      'responseStreamConnectionFailed' in info ||
      'responseStreamDisconnected' in info ||
      'responseTooManyFailedAttempts' in info)
  ) {
    return 'network';
  }
  if (info === 'badRequest' && TIER_REJECTION_PATTERN.test(message)) {
    return 'tier';
  }
  return 'unknown';
}
