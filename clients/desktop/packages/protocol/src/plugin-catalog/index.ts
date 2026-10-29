// ---------------------------------------------------------------------------
// Curated plugin catalog — wire contracts (protocol layer).
//
// These are the canonical request/response shapes for Canopy's curated
// **plugin** catalog (v0), served by Canopy Web and consumed by Canopy
// Desktop:
//   - Canopy Web serves `CuratedPluginListResponse` (metadata/manifests) and
//     `CuratedPluginContentResponse` (skill file bytes) from the curated
//     plugin catalog API.
//   - The desktop sync engine fetches those payloads, diffs them against a
//     locally materialized copy (keyed by `contentHash`), and writes the
//     result into a managed marketplace on disk.
//
// Curated plugins are NOT `ShareablePluginRef`s (see
// `packages/protocol/src/plugins/index.ts`): they are first-party, DB-backed
// catalog entries owned by Canopy Web, not portable references to a
// GitHub/built-in marketplace. `mcpServers` carries curated MCP catalog
// `key` values (see `packages/protocol/src/mcp-catalog/index.ts`); those keys
// are resolved client-side against `@canopy/protocol/mcp-catalog` data, not
// embedded here.
//
// Style mirrors `packages/protocol/src/mcp-catalog/index.ts` (pure
// interfaces, `as const` where needed, a `VERSION` const, no zod). This
// module is intentionally DEPENDENCY-FREE: it has ZERO imports so the
// dependency direction stays desktop-shared → protocol.
// ---------------------------------------------------------------------------

/**
 * Wire version of the curated plugin catalog API. Bump only on breaking shape
 * changes; additive optional fields do not require a bump.
 */
export const PLUGIN_CATALOG_API_VERSION = 1;

/** One file inside a curated skill, as advertised by the manifest/list API. */
export interface CuratedSkillFileManifestEntry {
  /**
   * Relative POSIX path within the skill dir, e.g. `"SKILL.md"`,
   * `"references/api.md"`. Validated by {@link isCuratedSkillFilePath}.
   */
  path: string;
  /** Lowercase hex digest of the file's UTF-8 bytes. */
  sha256: string;
  /** File size in bytes. */
  size: number;
}

/**
 * Manifest for one curated skill bundled with a plugin. Carries enough
 * structural metadata (file list + hashes) for the desktop sync engine to
 * decide whether it needs to fetch content, without the content itself.
 */
export interface CuratedPluginSkillManifest {
  /** Catalog slug for the skill; also the on-disk skill dir name. */
  key: string;
  name: string;
  /** Skill-level content hash. */
  contentHash: string;
  files: CuratedSkillFileManifestEntry[];
}

/**
 * One curated plugin entry as served by Canopy Web. Represents the catalog's
 * public metadata for a single plugin, including its bundled skill
 * manifests; local install/connection state is a separate desktop-only
 * concern and is not part of this wire shape.
 */
export interface CuratedPluginEntry {
  key: string;
  name: string;
  shortDescription: string;
  longDescription?: string;
  /** Optional example prompt; listing metadata, not installation content. */
  tryNowPrompt?: string;
  logoUrl?: string;
  version?: string;
  authorName?: string;
  authorUrl?: string;
  docsUrl?: string;
  /** Category slugs used for client-side sectioning/filtering. */
  categories: string[];
  /** Whether the entry belongs in the "Popular" section (client-side sections). */
  popular: boolean;
  /**
   * Whether this entry matches the requesting user's onboarding role, for the
   * client's "Recommended for you" section. Computed per request — the server
   * owns the matching rule because only it knows the stored role.
   *
   * Optional so a newer desktop keeps accepting catalogs from a server that
   * predates role targeting. Absent means "no recommendation signal", not
   * "not recommended".
   */
  recommended?: boolean;
  /** Ascending sort weight within a section (lower sorts first). */
  sortOrder: number;
  /** Plugin-level hash — the desktop's change-detection key. */
  contentHash: string;
  /** `CuratedMcpServerEntry.key` values (curated MCP catalog join keys). */
  mcpServers: string[];
  skills: CuratedPluginSkillManifest[];
  /** ISO-8601 timestamp of the entry's last update. */
  updatedAt: string;
}

/**
 * The full response payload of the curated plugin list API. `version` echoes
 * {@link PLUGIN_CATALOG_API_VERSION} at serve time so clients can gate on a
 * forward-incompatible bump.
 */
export interface CuratedPluginListResponse {
  version: number;
  plugins: CuratedPluginEntry[];
}

/** Curated plugin lifecycle events the desktop reports back to the catalog. */
export const CURATED_PLUGIN_EVENT_TYPES = ['INSTALLED'] as const;

export type CuratedPluginEventType =
  (typeof CURATED_PLUGIN_EVENT_TYPES)[number];

/**
 * Desktop → web report that a user installed a curated plugin.
 *
 * The client sends only what it alone knows. Everything attributable is
 * resolved server-side from the authenticated session and the catalog
 * (`actorUserId`, `brandId`, `curatedPluginId`, `profileRole`,
 * `recommendationScope`), so a client cannot misreport who installed what or
 * which targeting produced it.
 */
export interface CuratedPluginEventRequest {
  /**
   * Client-generated UUID making the write idempotent. The desktop retries
   * failed posts, and a double-counted install inflates the unique-user
   * numbers this endpoint exists to produce.
   */
  clientEventId: string;
  /** Curated catalog key. Matches the installed plugin's manifest name. */
  curatedPluginKey: string;
  eventType: CuratedPluginEventType;
  /** ISO-8601 instant the install completed on the client. */
  occurredAt: string;
}

/** Validates a {@link CuratedPluginEventRequest} received over the wire. */
export function isCuratedPluginEventRequest(
  value: unknown,
): value is CuratedPluginEventRequest {
  if (!isRecord(value)) return false;
  if (!isUuid(value.clientEventId)) return false;
  if (!isCuratedCatalogKey(value.curatedPluginKey)) return false;
  if (
    typeof value.eventType !== 'string' ||
    !CURATED_PLUGIN_EVENT_TYPES.some((type) => type === value.eventType)
  ) {
    return false;
  }
  return isIsoTimestamp(value.occurredAt);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

/**
 * One curated skill file, including its content bytes. Extends the manifest
 * shape so a content entry is a strict superset of its manifest entry.
 */
export interface CuratedSkillFileContentEntry extends CuratedSkillFileManifestEntry {
  /** File content, as UTF-8 text. */
  content: string;
}

/** Content payload for one curated skill bundled with a plugin. */
export interface CuratedPluginSkillContent {
  key: string;
  contentHash: string;
  files: CuratedSkillFileContentEntry[];
}

/**
 * The full response payload of the curated plugin content API: every skill's
 * file bytes for one plugin, keyed by `key`/`contentHash` for change
 * detection.
 */
export interface CuratedPluginContentResponse {
  version: number;
  key: string;
  contentHash: string;
  skills: CuratedPluginSkillContent[];
}

// ---------------------------------------------------------------------------
// Pure type guards.
//
// Mirror `packages/protocol/src/mcp-catalog/index.ts`: object guards check
// every field structurally, and array-valued fields are validated
// element-wise. Guards NEVER throw — malformed input returns `false` so a
// corrupt payload degrades to "empty catalog" rather than crashing a
// consumer.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

/**
 * Roles offered by the desktop onboarding role/intent step (CAN-1009), and the
 * vocabulary curated plugins target for recommendations.
 *
 * This lives in `@canopy/protocol` rather than `@canopy/desktop-shared`
 * because `apps/web` must not import desktop-shared, but both the web app and
 * the desktop tree already depend on protocol. `@canopy/desktop-shared/types`
 * re-exports it so existing desktop imports are unaffected.
 */
export const PROFILE_ROLES = [
  'software-engineer',
  'engineering-leader',
  'product-manager',
  'designer',
  'founder',
  'data-analytics',
  'marketing',
  'sales',
  // Retained on the wire for older profiles and curated plugin targeting.
  'marketing-sales',
  'operations',
  'support',
  // Retained on the wire for older profiles and curated plugin targeting.
  'operations-support',
  'student',
  'other',
] as const;

export type ProfileRoleId = (typeof PROFILE_ROLES)[number];

/** Preserve both answers when an older client saved the combined option. */
export function expandLegacyProfileRoles(
  roles: readonly ProfileRoleId[],
): ProfileRoleId[] {
  return Array.from(
    new Set(
      roles.flatMap((role): ProfileRoleId[] => {
        if (role === 'marketing-sales') return ['marketing', 'sales'];
        if (role === 'operations-support') return ['operations', 'support'];
        return [role];
      }),
    ),
  );
}

/** Partial account profile update. Full selections coexist with legacy primary roles. */
export interface OnboardingProfilePatch {
  profileRole?: ProfileRoleId | null;
  profileRoles?: ProfileRoleId[] | null;
  profileRoleDetail?: string | null;
  attributionSource?: string | null;
  attributionSourceDetail?: string | null;
}

/**
 * User-facing role names. Fixed product vocabulary, not brand-configurable —
 * the same category as `ui-labels.ts`, and centralised for the same reason: a
 * rename touches one line and every surface follows.
 *
 * Typed as a total `Record`, so adding a role to `PROFILE_ROLES` without a
 * label is a compile error rather than a blank entry in the wizard.
 */
export const PROFILE_ROLE_LABELS: Record<ProfileRoleId, string> = {
  'software-engineer': 'Software engineer',
  'engineering-leader': 'Engineering leader',
  'product-manager': 'Product manager',
  designer: 'Designer',
  founder: 'Founder or executive',
  'data-analytics': 'Data or analytics',
  marketing: 'Marketing',
  sales: 'Sales',
  'marketing-sales': 'Marketing or sales',
  operations: 'Operations',
  support: 'Support',
  'operations-support': 'Operations or support',
  student: 'Student',
  other: 'Other',
};

export interface ProfileRoleOption {
  id: ProfileRoleId;
  label: string;
}

/** Display order, excluding legacy wire-only roles. */
export const PROFILE_ROLE_OPTIONS: readonly ProfileRoleOption[] =
  PROFILE_ROLES.filter(
    (id) => id !== 'marketing-sales' && id !== 'operations-support',
  ).map((id) => ({
    id,
    label: PROFILE_ROLE_LABELS[id],
  }));

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

const CURATED_CATALOG_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WINDOWS_RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Shared portable directory-name rule for curated plugin and skill keys.
 * These keys become path segments on desktop, so catalog authors and desktop
 * consumers must reject the same Windows-reserved device names.
 */
export function isCuratedCatalogKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    CURATED_CATALOG_KEY_PATTERN.test(value) &&
    !WINDOWS_RESERVED_DEVICE_NAME.test(value)
  );
}

/**
 * Shared path-safety rule for a curated skill file path, used by both the web
 * admin zod schemas and the desktop sync engine: must be a non-empty string,
 * at most 256 characters, no leading `/`, and only path segments that are
 * portable across macOS and Windows filesystems.
 */
export function isCuratedSkillFilePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 256) return false;
  if (value.startsWith('/')) return false;
  if (value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.every((segment) => {
    if (
      segment.length === 0 ||
      new TextEncoder().encode(segment).byteLength > 255 ||
      segment === '.' ||
      segment === '..'
    ) {
      return false;
    }
    if (
      /[<>:"|?*]/.test(segment) ||
      /[ .]$/.test(segment) ||
      Array.from(segment).some((character) => character.charCodeAt(0) <= 0x1f)
    ) {
      return false;
    }
    return !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment);
  });
}

/** Structural checks shared by manifest and content skill-file guards. */
function hasValidSkillFileManifestFields(
  value: Record<string, unknown>,
): boolean {
  return (
    isCuratedSkillFilePath(value.path) &&
    isNonEmptyString(value.sha256) &&
    isFiniteNumber(value.size)
  );
}

/** Validates one curated skill file manifest entry structurally. */
export function isCuratedSkillFileManifestEntry(
  value: unknown,
): value is CuratedSkillFileManifestEntry {
  return isRecord(value) && hasValidSkillFileManifestFields(value);
}

/** Validates one curated plugin skill manifest structurally. */
export function isCuratedPluginSkillManifest(
  value: unknown,
): value is CuratedPluginSkillManifest {
  if (!isRecord(value)) return false;
  return (
    isCuratedCatalogKey(value.key) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.contentHash) &&
    Array.isArray(value.files) &&
    value.files.every(isCuratedSkillFileManifestEntry)
  );
}

/** Validates a single curated plugin entry structurally. */
export function isCuratedPluginEntry(
  value: unknown,
): value is CuratedPluginEntry {
  if (!isRecord(value)) return false;
  return (
    isCuratedCatalogKey(value.key) &&
    isNonEmptyString(value.name) &&
    typeof value.shortDescription === 'string' &&
    isOptionalString(value.longDescription) &&
    isOptionalString(value.tryNowPrompt) &&
    isOptionalString(value.logoUrl) &&
    isOptionalString(value.version) &&
    isOptionalString(value.authorName) &&
    isOptionalString(value.authorUrl) &&
    isOptionalString(value.docsUrl) &&
    isStringArray(value.categories) &&
    typeof value.popular === 'boolean' &&
    isOptionalBoolean(value.recommended) &&
    isFiniteNumber(value.sortOrder) &&
    isNonEmptyString(value.contentHash) &&
    isStringArray(value.mcpServers) &&
    Array.isArray(value.skills) &&
    value.skills.every(isCuratedPluginSkillManifest) &&
    typeof value.updatedAt === 'string'
  );
}

/**
 * Validates a curated plugin list response: a numeric `version` and a
 * `plugins` array whose every element is a valid {@link CuratedPluginEntry}.
 * Returns `false` for non-objects or any malformed entry.
 */
export function isCuratedPluginListResponse(
  value: unknown,
): value is CuratedPluginListResponse {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.version) &&
    Array.isArray(value.plugins) &&
    value.plugins.every(isCuratedPluginEntry)
  );
}

/** Validates one curated skill file content entry structurally. */
export function isCuratedSkillFileContentEntry(
  value: unknown,
): value is CuratedSkillFileContentEntry {
  if (!isRecord(value)) return false;
  return (
    hasValidSkillFileManifestFields(value) && typeof value.content === 'string'
  );
}

/** Validates one curated plugin skill content payload structurally. */
export function isCuratedPluginSkillContent(
  value: unknown,
): value is CuratedPluginSkillContent {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.key) &&
    isNonEmptyString(value.contentHash) &&
    Array.isArray(value.files) &&
    value.files.every(isCuratedSkillFileContentEntry)
  );
}

/**
 * Validates a curated plugin content response: a numeric `version`, a
 * `key`/`contentHash` pair, and a `skills` array whose every element is a
 * valid {@link CuratedPluginSkillContent}. Returns `false` for non-objects or
 * any malformed entry.
 */
export function isCuratedPluginContentResponse(
  value: unknown,
): value is CuratedPluginContentResponse {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.version) &&
    isNonEmptyString(value.key) &&
    isNonEmptyString(value.contentHash) &&
    Array.isArray(value.skills) &&
    value.skills.every(isCuratedPluginSkillContent)
  );
}

export {
  DEFAULT_PLUGIN_RECOMMENDATION_ROLE,
  ROLE_PLUGIN_RECOMMENDATIONS,
} from './role-recommendations';
