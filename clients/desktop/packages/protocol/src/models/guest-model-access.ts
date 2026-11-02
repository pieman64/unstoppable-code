// ---------------------------------------------------------------------------
// Guest and signed-in non-payer model allowlist (CAN-3026).
// This is the single live allowlist for locked model-library access. Auto
// requires unlocked access. Funds, grants and trials never widen this list.
//
// A guest principal may run ONLY the models listed here anywhere Canopy pays
// for the inference — the LLM proxy, cloud chat, and the desktop AI-Credits
// lane. A guest-account farm burned ~$1.3k in 24h on `anthropic/claude-fable-5.1`
// through the LLM proxy, whose only model check enforced ORGANIZATION policy; a
// guest belongs to no organization, so every gateway model was reachable.
//
// WHY A CLOSED ALLOWLIST, NOT A DENYLIST OR A PRICE THRESHOLD:
// a model newly added to the gateway, to Core, or to `CLOUD_ONLY_MODELS` is NOT
// reachable by a guest until it is deliberately added to the table below. New
// capacity therefore defaults to "signed-in only" rather than defaulting to
// reachable-and-expensive, which is the failure mode this module exists to end.
//
// WHY MINIMAL NORMALIZATION (trim + lowercase, exact spelling match):
// every stripping rule WIDENS reach. Stripping a vendor prefix admits
// `other-vendor/gpt-5.6-luna`; stripping a suffix admits `gpt-5.6-luna[1m]`;
// unwrapping admits `agent_model_*` wrappers. Each accepted spelling is written
// out explicitly instead. `undefined`, non-strings, and unknown spellings all
// fail closed through the same lookup, with no extra branch to get wrong.
//
// WHY THESE FOUR MODELS:
//   - `gpt-6-luna` is the guest model on web and desktop: cloud chat pins a
//     guest to it (`GUEST_DEFAULT_MODEL_ID`) and the desktop AI-Credits lane
//     falls back to it when DeepSeek cannot route. $0.10/$0.50 per Mtok.
//   - `gpt-5.6-luna` is kept only so shipped desktop builds (internal-404 to
//     406), which fall back to it, keep working. Remove it once those builds
//     age out.
//   - `deepseek-v4-pro` is the FIRST entry in `CREDITS_LANE_DEFAULT_CANDIDATES`
//     (`@canopy/desktop-shared` `lib/default-model-lane`), i.e. the AI-Credits
//     lane default in ALREADY-SHIPPED desktop builds. Omitting it would break
//     every installed desktop app sitting on its own default the moment this
//     gate deploys, with no client update path.
//   - `claude-haiku-5.5` gives a guest a Claude option at Luna-tier cost
//     ($0.10/$0.50 per Mtok).
// Prices are the base gateway rates in `../model-routing` (pricing revision
// `MODEL_ROUTING_PRICING_REVISION`). Long-context requests bill higher: Haiku
// 5.5 at $0.50/$2.50 above 100k input tokens, GPT 6 Luna at $0.20/$0.75 above
// 272k. Both stay far under Fable 5.1's $10/$50.
// Every entry sits at least an order of magnitude under Fable per Mtok (5.6
// Luna $0.20/$1.20, DeepSeek V4 Pro ~$0.435/$0.87), so admitting them does
// not reopen the hole this module closes.
//
// Only gateway and bare client spellings are listed. Haiku's desktop registry
// id (`haiku`) and Cursor alias (`claude-haiku-5-5`) are deliberately absent:
// the desktop gates (`isGuestAllowedCreditsModel`, the picker row gate) test
// the RESOLVED gateway id, and the proxy only ever sees gateway ids, so adding
// them would only widen the exact-spelling surface.
//
// WHAT THIS CARVE-OUT DELIBERATELY DOES *NOT* COVER (CAN-3026 review round 2).
// `deepseek-v4-pro` rescues the FIRST lane candidate, not every model a shipped
// guest can already be sitting on. Two populations are knowingly hard-cut:
//   - a guest with a CONFIGURED credits-lane default (`defaults.aiCredits`),
//     which `defaultCandidates` returns ahead of `CREDITS_LANE_DEFAULT_CANDIDATES`;
//   - a guest whose lane fell through to `CREDITS_LANE_DEFAULT_CANDIDATES[1]`,
//     i.e. `DEFAULT_CODEX_MODEL`, because DeepSeek was not routable at the time.
// Neither gets a pre-turn prompt, because the picker's row gate deliberately
// skips `model === currentModel` and nothing rewrites a persisted selection.
// Their first turn is refused by the proxy. That refusal is why
// `guest_model_not_allowed` is a MARKED proxy error: the desktop renders it as
// a notice with a sign-in route rather than a raw 403, which is the recovery
// path for exactly this population. Widening the allowlist further would trade
// that one-time interruption for ongoing spend on models this gate exists to
// stop, so the interruption is the accepted cost — not an oversight.
//
// Must stay pure and browser-safe: no Node, Electron, React, Prisma, or Next.
// ---------------------------------------------------------------------------

/** One model a guest principal may run, in both spellings clients use. */
export interface GuestAllowedModel {
  /** Bare client model id, as the desktop picker and cloud chat spell it. */
  readonly id: string;
  /** Vendor-prefixed gateway id, as the LLM proxy body spells it. */
  readonly gatewayId: string;
  /** Display label for refusal and gate copy. */
  readonly label: string;
}

/**
 * Cheap models a guest principal may run where Canopy pays for inference.
 *
 * Order matters: it is the desktop guest fallback order on the AI-Credits lane
 * and the label order in refusal copy.
 *
 * Every id and gatewayId MUST be lowercase: the lookup set is built by
 * `flatMap` over this table and compared against a lowercased input, so an
 * uppercase literal here would be permanently unmatchable. A test pins that.
 */
export const GUEST_ALLOWED_MODELS: readonly GuestAllowedModel[] = [
  {
    id: 'gpt-6-luna',
    gatewayId: 'openai/gpt-6-luna',
    label: 'GPT 6 Luna',
  },
  {
    id: 'gpt-5.6-luna',
    gatewayId: 'openai/gpt-5.6-luna',
    label: 'GPT 5.6 Luna',
  },
  {
    id: 'deepseek-v4-pro',
    gatewayId: 'deepseek/deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
  },
  {
    id: 'claude-haiku-5.5',
    gatewayId: 'anthropic/claude-haiku-5.5',
    label: 'Claude Haiku 5.5',
  },
] as const;

/**
 * Cloud chat's guest pin / reset target.
 *
 * Deliberately a single id even though the allowlist has several entries: a
 * chat being CREATED or REPAIRED needs one concrete model, while a chat already
 * on any allowlist member is left alone. Desktop does not use this id alone: it
 * keeps its own lane default (`deepseek-v4-pro`) and, when that cannot route,
 * walks `GUEST_ALLOWED_MODELS` in table order, so a guest's desktop default is
 * an allowlisted model, or no model when none of them can route.
 */
export const GUEST_DEFAULT_MODEL_ID = 'gpt-6-luna';

/**
 * Every accepted spelling, derived from the table so adding a row admits both
 * of its spellings automatically and nothing else changes.
 */
const GUEST_ALLOWED_MODEL_SPELLINGS: ReadonlySet<string> = new Set(
  GUEST_ALLOWED_MODELS.flatMap((model) => [model.id, model.gatewayId]),
);

/**
 * Whether a guest principal may run this model id.
 *
 * Fails closed for `undefined`, a non-string, and any spelling not written out
 * in `GUEST_ALLOWED_MODELS`. Input is trimmed and lowercased only — see the
 * header for why no further normalization is applied.
 *
 * Takes `unknown` rather than `string | undefined` deliberately, matching the
 * other protocol validators. The proxy reads `model` straight off an untrusted
 * JSON body, so "not a string" is a real runtime input this must answer for,
 * not a type error at the call site — and a narrower signature only forces
 * callers (and tests) to cast their way past it, which the repository's
 * no-type-casting rule forbids and which would defeat the fail-closed promise
 * this function makes.
 */
export function isGuestAllowedModelId(modelId: unknown): boolean {
  if (typeof modelId !== 'string') return false;
  return GUEST_ALLOWED_MODEL_SPELLINGS.has(modelId.trim().toLowerCase());
}

/**
 * Preferred guest alternative for a resolved vendor/model gateway id.
 *
 * Uses the first allowlist entry for the normalized vendor, including when the
 * input is itself allowlisted. This is a preference lookup, not authorization
 * or a registry lookup: callers must resolve the input gateway id and verify
 * the candidate's registry mapping, selection identity and host availability.
 * Bare client ids and malformed gateway ids have no preference.
 */
export function resolveGuestAllowedModelForGatewayId(
  gatewayId: unknown,
): GuestAllowedModel | undefined {
  if (typeof gatewayId !== 'string') return undefined;

  const [vendor, model, ...extraSegments] = gatewayId
    .trim()
    .toLowerCase()
    .split('/');
  if (!vendor || !model || extraSegments.length > 0) return undefined;

  return GUEST_ALLOWED_MODELS.find(
    (candidate) => candidate.gatewayId.split('/')[0] === vendor,
  );
}

/**
 * `GPT 6 Luna, GPT 5.6 Luna, DeepSeek V4 Pro or Claude Haiku 5.5` — for
 * refusal and gate copy.
 *
 * Disjunction, not conjunction: a guest picks one of these, they do not get all
 * of them. Built by hand rather than with `Intl.ListFormat` so the string is
 * identical on every host and in every test, independent of ICU data and of the
 * TypeScript `lib` each consuming package compiles against.
 */
export function formatGuestAllowedModelLabels(): string {
  const labels = GUEST_ALLOWED_MODELS.map((model) => model.label);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}
