/**
 * Wire contract for hub-served activation notification campaigns (CAN-2765).
 *
 * The desktop engine ships a compiled campaign table; this contract lets that
 * table be replaced at runtime so timing and copy change without a desktop
 * release. The parser below is the ONLY way a served payload becomes campaign
 * data, and it is deliberately total and strict: anything it cannot fully
 * validate returns `null`, and the caller falls back to the compiled table.
 *
 * Strictness is not fussiness. A served config drives OS notifications sent
 * once per install; a coerced offset of `0` would fire every campaign at once
 * at users, and an unknown destination would land them on a dead screen. There
 * is no partial application — a payload is wholly valid or wholly ignored.
 */

export const NOTIFICATION_CAMPAIGN_CONFIG_VERSION = 1;

/**
 * Copy is templated rather than literal. Hub-authored strings must not carry
 * product names directly: user-visible names come from the brand runtime, and
 * a served literal would bypass that entirely. Desktop substitutes these at
 * render time.
 */
export const CAMPAIGN_COPY_TOKENS = ['{appName}'] as const;

export type CampaignCopyToken = (typeof CAMPAIGN_COPY_TOKENS)[number];

/**
 * The campaigns a served document may configure, and the variant keys each
 * one's resolver can actually produce.
 *
 * These live here rather than only in the desktop mapper so the SERVER can
 * reject the same documents the client would. Previously publish validated
 * with the parser alone, so a document naming an unknown campaign or a
 * destination desktop refuses was accepted with a 200, then rejected
 * wholesale by every client -- one bad entry silently reverted every campaign
 * for that brand to compiled, with no 422 and no signal anywhere.
 *
 * Plain string literals, deliberately: the desktop mapper narrows them to its
 * own `ActivationCampaignId` / `NavigationPage` / `SettingsSection` unions, so
 * renderer vocabulary still does not live in protocol.
 */
export const SERVED_CAMPAIGN_IDS = [
  'activation-first-task',
  'activation-role-branch',
  'activation-marketplace',
  'activation-mobile',
] as const;

export type ServedCampaignId = (typeof SERVED_CAMPAIGN_IDS)[number];

/**
 * Every key the campaign's resolver can return. A document missing one of
 * these publishes fine and then suppresses forever as `variant-unavailable`
 * -- a terminal reason that arms no retry -- so the campaign is silently
 * reconfigured into permanent silence. Requiring them makes that a 422.
 */
export const REQUIRED_CAMPAIGN_VARIANT_KEYS: Readonly<
  Record<ServedCampaignId, readonly string[]>
> = {
  'activation-first-task': ['default', 'offer'],
  'activation-role-branch': ['developer', 'business'],
  'activation-marketplace': ['default'],
  'activation-mobile': ['default'],
};

/** Pages a campaign may deep-link to. An allowlist, not every NavigationPage. */
export const SERVED_CAMPAIGN_PAGES = [
  'home',
  'main',
  'plugins',
  'pipelines',
  'automations',
] as const;

/** Settings panes a campaign may deep-link to. */
export const SERVED_CAMPAIGN_SETTINGS_SECTIONS = [
  'mcp',
  'plugins',
  'account',
  'harnesses',
] as const;

/** Mirrors the desktop `CampaignAnchor`. */
export const SERVED_CAMPAIGN_ANCHORS = ['first-open', 'abandonment'] as const;

export type ServedCampaignAnchor = (typeof SERVED_CAMPAIGN_ANCHORS)[number];

/**
 * Mirrors the desktop `CampaignDestination` closed union. Kept as its own type
 * rather than imported from desktop-shared because protocol may not depend on
 * it; the desktop-side mapper is what proves the two stay aligned.
 */
export type ServedCampaignDestination =
  | { kind: 'page'; page: string }
  | { kind: 'canopy-portal' }
  | { kind: 'add-workspace' }
  | { kind: 'settings'; section: string };

/**
 * Declared as type aliases rather than interfaces on purpose: an interface has
 * no implicit index signature, so it is not assignable to Prisma's
 * `InputJsonValue` even when it is structurally JSON. Aliases keep the server
 * able to persist a parsed document without forcing the type with `as`.
 */
export type ServedCampaignVariant = {
  title: string;
  body: string;
  destination: ServedCampaignDestination;
};

export type ServedCampaign = {
  id: ServedCampaignId;
  anchor: ServedCampaignAnchor;
  offsetMs: number;
  maxLatenessMs: number;
  /** Must contain at least one variant. */
  variants: Record<string, ServedCampaignVariant>;
};

export type ServedCampaignConfig = {
  version: number;
  /**
   * Opaque revision, changed on every publish. Currently a diagnostic that
   * identifies which document a client applied; desktop does not yet compare
   * it to skip re-applying an unchanged payload.
   */
  revision: string;
  campaigns: ServedCampaign[];
};

const MAX_CAMPAIGNS = 32;
const MAX_VARIANTS_PER_CAMPAIGN = 16;
const MAX_COPY_LENGTH = 240;
/**
 * A campaign may not be scheduled more than a year out, and must be at least a
 * second away. Both bounds exist so a bad number cannot turn into "fire now at
 * everyone" or "never fire".
 */
const MIN_OFFSET_MS = 1_000;
const MAX_OFFSET_MS = 365 * 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isBoundedDuration(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= MIN_OFFSET_MS &&
    value <= MAX_OFFSET_MS
  );
}

function parseDestination(value: unknown): ServedCampaignDestination | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case 'page':
      return typeof value.page === 'string' &&
        (SERVED_CAMPAIGN_PAGES as readonly string[]).includes(value.page)
        ? { kind: 'page', page: value.page }
        : null;
    case 'settings':
      return typeof value.section === 'string' &&
        (SERVED_CAMPAIGN_SETTINGS_SECTIONS as readonly string[]).includes(
          value.section,
        )
        ? { kind: 'settings', section: value.section }
        : null;
    case 'canopy-portal':
      return { kind: 'canopy-portal' };
    case 'add-workspace':
      return { kind: 'add-workspace' };
    default:
      // An unrecognized destination is rejected rather than defaulted: a
      // served kind this build does not understand must not become a click
      // that dead-ends.
      return null;
  }
}

/**
 * Rejects copy containing a `{...}` placeholder this contract does not
 * define. An unknown token renders verbatim into an OS notification, so
 * `{userName}` would ship literally to users. Cheaper to refuse at publish
 * than to discover in a screenshot.
 */
function hasOnlyKnownTokens(text: string): boolean {
  const tokens = text.match(/\{[^{}]*\}/g);
  if (tokens === null) return true;
  return tokens.every((token) =>
    (CAMPAIGN_COPY_TOKENS as readonly string[]).includes(token),
  );
}

function parseVariant(value: unknown): ServedCampaignVariant | null {
  if (!isRecord(value)) return null;
  if (!isBoundedString(value.title, MAX_COPY_LENGTH)) return null;
  if (!isBoundedString(value.body, MAX_COPY_LENGTH)) return null;
  if (!hasOnlyKnownTokens(value.title)) return null;
  if (!hasOnlyKnownTokens(value.body)) return null;
  const destination = parseDestination(value.destination);
  if (destination === null) return null;
  return { title: value.title, body: value.body, destination };
}

function isServedCampaignId(value: unknown): value is ServedCampaignId {
  return (
    typeof value === 'string' &&
    (SERVED_CAMPAIGN_IDS as readonly string[]).includes(value)
  );
}

function isAnchor(value: unknown): value is ServedCampaignAnchor {
  return (
    typeof value === 'string' &&
    (SERVED_CAMPAIGN_ANCHORS as readonly string[]).includes(value)
  );
}

/**
 * `__proto__` reaches here from `JSON.parse` and, assigned to an object
 * literal, invokes the prototype setter instead of creating an own property:
 * the entry count guard below would see a variant that then does not exist.
 * `constructor`/`prototype` are rejected for the same class of surprise.
 */
const FORBIDDEN_VARIANT_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

function parseCampaign(value: unknown): ServedCampaign | null {
  if (!isRecord(value)) return null;
  // A guard rather than a throwing narrower: this module is documented as
  // total, and a slip would surface as a 500 from publish rather than a 422.
  const campaignId = value.id;
  if (!isServedCampaignId(campaignId)) return null;
  const anchor = value.anchor;
  if (!isAnchor(anchor)) return null;
  if (!isBoundedDuration(value.offsetMs)) return null;
  if (!isBoundedDuration(value.maxLatenessMs)) return null;
  if (!isRecord(value.variants)) return null;

  const entries = Object.entries(value.variants);
  if (entries.length === 0 || entries.length > MAX_VARIANTS_PER_CAMPAIGN) {
    return null;
  }
  // Built from entries rather than assigned key-by-key so a hub-authored
  // `__proto__` cannot end up on the prototype instead of the object.
  const parsedEntries: [string, ServedCampaignVariant][] = [];
  for (const [key, raw] of entries) {
    if (!isBoundedString(key, 64)) return null;
    if (FORBIDDEN_VARIANT_KEYS.has(key)) return null;
    const variant = parseVariant(raw);
    if (variant === null) return null;
    parsedEntries.push([key, variant]);
  }
  const variants: Record<string, ServedCampaignVariant> =
    Object.fromEntries(parsedEntries);

  // Every key the resolver can emit must be present, or the campaign
  // suppresses forever as `variant-unavailable` once deployed.
  for (const required of REQUIRED_CAMPAIGN_VARIANT_KEYS[campaignId]) {
    if (variants[required] === undefined) return null;
  }

  return {
    id: campaignId,
    anchor,
    offsetMs: value.offsetMs,
    maxLatenessMs: value.maxLatenessMs,
    variants,
  };
}

/**
 * Validate a served payload. Returns `null` for anything that is not wholly
 * valid, including a version this build does not recognize — a newer schema
 * may carry semantics this build would misread, so it falls back rather than
 * guessing.
 */
export function parseServedCampaignConfig(
  value: unknown,
): ServedCampaignConfig | null {
  if (!isRecord(value)) return null;
  if (value.version !== NOTIFICATION_CAMPAIGN_CONFIG_VERSION) return null;
  if (!isBoundedString(value.revision, 128)) return null;
  if (!Array.isArray(value.campaigns)) return null;
  if (value.campaigns.length > MAX_CAMPAIGNS) return null;

  const campaigns: ServedCampaign[] = [];
  const seen = new Set<string>();
  for (const raw of value.campaigns) {
    const campaign = parseCampaign(raw);
    if (campaign === null) return null;
    // A duplicate id would make which definition wins depend on array order,
    // and the send-once latch is keyed by id.
    if (seen.has(campaign.id)) return null;
    seen.add(campaign.id);
    campaigns.push(campaign);
  }

  return {
    version: NOTIFICATION_CAMPAIGN_CONFIG_VERSION,
    revision: value.revision,
    campaigns,
  };
}
