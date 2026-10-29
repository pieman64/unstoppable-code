// ---------------------------------------------------------------------------
// Public user profile contracts (opt-in `/profile/<username>` surface).
//
// Single source of truth for the serializable shapes that cross the web API ⇄
// browser boundary for the public profile feature: username rules, the social
// link contract, the public profile read DTO, and the per-artifact publishing
// card/detail union.
//
// READ/serialization DTOs only. Stays dependency-free (no Node, Prisma, or
// React) so the web service and the browser can both import it. Intra-package
// relative imports of already-serializable protocol types are allowed (same as
// `runs` importing from `portal`).
// ---------------------------------------------------------------------------

import type { MemberProfileLink } from '../team/index.js';
import type { TelemetryHeadlineCard } from '../telemetry/index.js';
import type { SharedRunRollup } from '../runs/index.js';

export type { MemberProfileLink } from '../team/index.js';
export type { TelemetryHeadlineCard } from '../telemetry/index.js';
export type { SharedRunRollup } from '../runs/index.js';

// ===========================================================================
// Username rules.
// ===========================================================================

export const PUBLIC_USERNAME_MIN_LENGTH = 3;
export const PUBLIC_USERNAME_MAX_LENGTH = 40;

/**
 * Charset gate: lowercase alphanumerics and hyphens, must start with an
 * alphanumeric. Length is validated separately so the error is specific. The
 * no-trailing-hyphen and no-double-hyphen rules are enforced in
 * {@link validatePublicUsername}, not in this pattern.
 */
export const PUBLIC_USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*)$/;

export const PUBLIC_PROFILE_BIO_MAX_LENGTH = 512;
export const PUBLIC_PROFILE_MAX_LINKS = 5;

export type UsernameValidationError =
  | 'length'
  | 'charset'
  | 'hyphen'
  | 'reserved';

export type ValidatePublicUsernameResult =
  | { ok: true; username: string }
  | { ok: false; error: UsernameValidationError };

/**
 * Reserved usernames that must never be claimable: every top-level app path
 * segment (so a profile can never shadow a real route), infra/abuse staples,
 * and brand/product names. Kept lowercase; the validator lowercases input
 * before consulting this set.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  // Top-level app path segments.
  'api',
  'account',
  'admin',
  'administrator',
  'auth-complete',
  'brand',
  'checkout',
  'desktop-auth',
  'download',
  'favicon.ico',
  'icon.png',
  'invite',
  'login',
  'opengraph-image',
  'organization',
  'pending',
  'plans',
  'portal',
  'pricing',
  'privacy',
  'profile',
  'runs',
  's',
  'terms',
  'two-factor',
  // Infra / well-known.
  '_next',
  'about',
  'assets',
  'badge',
  'blog',
  'docs',
  'help',
  'legal',
  'mail',
  'moderator',
  'official',
  'root',
  'security',
  'settings',
  'staff',
  'static',
  'status',
  'support',
  'team',
  'well-known',
  'www',
  // Brand / product names.
  'anthropic',
  'canopy',
  'claude',
  'ud',
  'unstoppable',
  'unstoppabledomains',
]);

/**
 * Normalize and validate a claimed public username. Lowercases and trims first,
 * then checks length, charset, hyphen rules, and the reserved set. Returns a
 * discriminated result carrying the canonical (lowercase) username on success.
 */
export function validatePublicUsername(
  raw: string,
): ValidatePublicUsernameResult {
  const username = raw.trim().toLowerCase();
  if (
    username.length < PUBLIC_USERNAME_MIN_LENGTH ||
    username.length > PUBLIC_USERNAME_MAX_LENGTH
  ) {
    return { ok: false, error: 'length' };
  }
  if (!PUBLIC_USERNAME_PATTERN.test(username)) {
    return { ok: false, error: 'charset' };
  }
  if (username.endsWith('-') || username.includes('--')) {
    return { ok: false, error: 'hyphen' };
  }
  if (RESERVED_USERNAMES.has(username)) {
    return { ok: false, error: 'reserved' };
  }
  return { ok: true, username };
}

// ===========================================================================
// Social links.
// ===========================================================================

export const PROFILE_SOCIAL_PLATFORMS = [
  'x',
  'github',
  'linkedin',
  'youtube',
  'website',
] as const;

export type ProfileSocialPlatform = (typeof PROFILE_SOCIAL_PLATFORMS)[number];

export function isProfileSocialPlatform(
  value: string,
): value is ProfileSocialPlatform {
  const platforms: readonly string[] = PROFILE_SOCIAL_PLATFORMS;
  return platforms.includes(value);
}

/**
 * One validated external profile link. Https-only, one per platform.
 *
 * Intentionally distinct from the public read DTO's {@link MemberProfileLink}
 * (`{ label, url }`): `SocialLink` is the *settings input* shape keyed by a
 * constrained `platform` enum, while `MemberProfileLink` is the *display* shape
 * carrying a free-form `label`. The one-way mapping (`platform` → `label`) lives
 * in a single place (`parseLinks` in `public-profile-service.ts`), so the two
 * shapes cannot silently drift — do not unify them.
 */
export interface SocialLink {
  platform: ProfileSocialPlatform;
  url: string;
}

export type SocialLinkValidationError =
  | 'too-many'
  | 'unknown-platform'
  | 'duplicate-platform'
  | 'invalid-url'
  | 'not-https';

export type ValidateSocialLinksResult =
  | { ok: true; links: SocialLink[] }
  | { ok: false; error: SocialLinkValidationError };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validate an untrusted social-link array: at most
 * {@link PUBLIC_PROFILE_MAX_LINKS}, known platforms only, one entry per
 * platform, https URLs only. Trusts the user (no ownership/handle verification
 * for MVP). Returns the normalized typed array on success.
 */
export function validateSocialLinks(value: unknown): ValidateSocialLinksResult {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'invalid-url' };
  }
  if (value.length > PUBLIC_PROFILE_MAX_LINKS) {
    return { ok: false, error: 'too-many' };
  }
  const seen = new Set<ProfileSocialPlatform>();
  const links: SocialLink[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return { ok: false, error: 'invalid-url' };
    }
    const platform = entry.platform;
    const url = entry.url;
    if (typeof platform !== 'string' || !isProfileSocialPlatform(platform)) {
      return { ok: false, error: 'unknown-platform' };
    }
    if (seen.has(platform)) {
      return { ok: false, error: 'duplicate-platform' };
    }
    if (typeof url !== 'string') {
      return { ok: false, error: 'invalid-url' };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: 'invalid-url' };
    }
    if (parsed.protocol !== 'https:') {
      return { ok: false, error: 'not-https' };
    }
    seen.add(platform);
    links.push({ platform, url: parsed.toString() });
  }
  return { ok: true, links };
}

// ===========================================================================
// Public profile read DTO.
// ===========================================================================

export interface PublicProfileHeatmapDay {
  /** UTC day, `YYYY-MM-DD`. */
  date: string;
  count: number;
}

export interface PublicProfileIdentity {
  username: string;
  name: string;
  image: string | null;
  bio: string | null;
  links: ReadonlyArray<MemberProfileLink>;
  /** ISO timestamp of the user's account creation. */
  joinedAtIso: string;
}

/** Canopy subscription tier that always renders when cost is shown. */
export type CanopyPlanTier = 'free' | 'individual' | 'business';

/** One provider-subscription line in the flex lineup. */
export interface ProfileSubscriptionLine {
  /** Human-readable plan label (e.g. `Claude Max 20x`); never a raw account key. */
  planLabel: string;
  count: number;
}

export interface ProfileSubscriptionLineup {
  canopyTier: CanopyPlanTier;
  /** Empty when there is no provider attribution. */
  providers: ProfileSubscriptionLine[];
}

// --- Published artifact cards / detail. ------------------------------------

export type PublicArtifactKind = 'skill' | 'plan' | 'run' | 'pipeline';

export interface PublicArtifactBase {
  /** Publish-row externalId (uuid) for plan/run/pipeline; skill share externalId. */
  id: string;
  title: string;
  /** ISO timestamp the artifact was published. */
  publishedAt: string;
}

export interface PublicSkillArtifactCard extends PublicArtifactBase {
  kind: 'skill';
  pinnedName: string;
  pinnedDescription: string;
  /** Canonical share path (`SKILL_SHARE_PATH_PREFIX`/`<externalId>`). */
  sharePath: string;
}

export interface PublicRunArtifactCard extends PublicArtifactBase {
  kind: 'run';
  summary: string;
  rollup: SharedRunRollup;
}

export interface PublicPlanArtifactCard extends PublicArtifactBase {
  kind: 'plan';
}

export interface PublicPipelineArtifactCard extends PublicArtifactBase {
  kind: 'pipeline';
  description: string;
}

export type PublicProfileArtifactCard =
  | PublicSkillArtifactCard
  | PublicRunArtifactCard
  | PublicPlanArtifactCard
  | PublicPipelineArtifactCard;

export interface PublicProfileSharedItem {
  kind: 'skill' | 'pipeline';
  name: string;
  description: string;
  sharePath: string;
  sharedAt: string;
}

/**
 * Server-side superset used while profile presentation adopts all reusable
 * public-share kinds. `PublicProfileSharedItem` remains the currently rendered
 * subset until the frontend migration consumes this contract.
 */
export interface PublicProfileReusableSharedItem {
  kind:
    | 'skill'
    | 'pipeline'
    | 'automation'
    | 'agent'
    | 'collection'
    | 'plugin'
    | 'project-template';
  name: string;
  description: string;
  sharePath: string;
  sharedAt: string;
}

export interface PublicPlanArtifactDetail extends PublicPlanArtifactCard {
  content: string;
}

export interface PublicPipelineArtifactDetail extends PublicPipelineArtifactCard {
  rawPipeline: string;
}

export type PublicProfileArtifactDetail =
  | PublicRunArtifactCard
  | PublicPlanArtifactDetail
  | PublicPipelineArtifactDetail;

export interface PublicProfileResponse {
  identity: PublicProfileIdentity;
  /** Lifetime impact score. */
  impactScore: number;
  /** Last-30-day impact score (the recent window). */
  recentImpactScore: number;
  /** Last-7-day impact score (the week window). */
  weekImpactScore: number;
  /** Null only when `showCost` is off; `providers` empty when no attribution. */
  subscriptionLineup: ProfileSubscriptionLineup | null;
  /** Lifetime metric cards; `previousValue` is always null (no trend). */
  lifetimeCards: TelemetryHeadlineCard[];
  /** Last-30-day cards; `previousValue` is the prior 30-day window. */
  recentCards: TelemetryHeadlineCard[];
  /** Last-7-day cards; `previousValue` is the prior 7-day window. */
  weekCards: TelemetryHeadlineCard[];
  /** Null when hidden by the `showHeatmap` toggle. */
  heatmap: PublicProfileHeatmapDay[] | null;
  artifacts: PublicProfileArtifactCard[];
  sharedItems: PublicProfileSharedItem[];
}

// ===========================================================================
// Structural guards (validated client-side in the account manager).
// ===========================================================================

export function isPublicProfileArtifactCard(
  value: unknown,
): value is PublicProfileArtifactCard {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.publishedAt !== 'string'
  ) {
    return false;
  }
  return (
    value.kind === 'skill' ||
    value.kind === 'run' ||
    value.kind === 'plan' ||
    value.kind === 'pipeline'
  );
}
