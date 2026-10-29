import {
  isDataSharingOptInFeature,
  type DataSharingOptInFeature,
} from '../canopy-server';
import {
  isSharedAutomationContentHash,
  type SharedAutomationDocument,
} from '../automations';
import type { ShareablePluginRef } from '../plugins';
import type {
  SharedCollectionDocument,
  SharedCollectionItemCounts,
} from '../collections';
import { isCuratedCatalogKey } from '../plugin-catalog';
import type { SharedAgentDocument } from '../agents';
import {
  isWorkspaceTemplateContentHash,
  type SharedWorkspaceTemplateDocument,
} from '../workspace-templates';
import {
  PIPELINE_PACKAGE_CLIENT_VERSION,
  isPipelineContentHash,
  isPipelinePackageDigest,
  type PipelineDistributionMode,
  type PipelinePackageSummary,
} from '../pipelines/package';

/**
 * Package client versions a deep link may carry.
 *
 * Every version this repo has ever issued stays acceptable: links live in
 * chat messages and bookmarks long after a client version is superseded, and
 * refusing an older one would strand a share that is still perfectly
 * installable.
 */
export type DesktopShareDeepLinkPackageVersion =
  | 1
  | 2
  | 3
  | typeof PIPELINE_PACKAGE_CLIENT_VERSION;

/**
 * Any version from 1 up to the current client, rather than a literal list.
 * A list has to be edited on every bump, and forgetting to strands the links
 * minted by the version it dropped — which is exactly what the doc comment
 * above promises will never happen.
 */
function isDesktopShareDeepLinkPackageVersion(
  value: number,
): value is DesktopShareDeepLinkPackageVersion {
  return (
    Number.isInteger(value) &&
    value >= 1 &&
    value <= PIPELINE_PACKAGE_CLIENT_VERSION
  );
}

/**
 * Desktop share deep-link wire contract (CAN-2361).
 *
 * Public `/share/*` pages offer an "Open in <brand>" CTA that hands the shared
 * entity off to the desktop app through a per-brand custom URL scheme:
 *
 *   <scheme>://share/skills/<uuid>
 *   <scheme>://share/pipelines/<uuid>
 *
 * The scheme is the brand's `internalName` — the same token the mobile app
 * already uses for its OAuth callback deep links (`<scheme>://auth?...`). The
 * two apps never register the scheme on the same OS (mobile owns iOS/Android,
 * desktop owns macOS/Windows/Linux), and payloads are disambiguated by URL
 * host: mobile owns host `auth`, desktop claims host `share` only. Should the
 * mobile app ever ship to macOS (Catalyst / iPad-apps-on-Mac), both could
 * claim the scheme there; the fallback is a distinct desktop scheme
 * (`<internalName>-desktop`) — revisit this contract before that happens.
 *
 * Deep links are untrusted input. `parseDesktopShareDeepLink` is the single
 * validation chokepoint: anything that is not exactly a share link for the
 * expected scheme — including mobile OAuth callbacks on host `auth` — parses
 * to `null` and must be dropped silently, without logging the URL (a stray
 * OAuth callback carries result params that must never reach logs).
 *
 * Web builds these links and desktop parses them, so both live here as the
 * environment-neutral single source of truth. The path segments deliberately
 * mirror the web share paths (`SKILL_SHARE_PATH_PREFIX`,
 * `PIPELINE_SHARE_PATH_PREFIX`): a deep link is the share URL with the origin
 * swapped for `<scheme>://`.
 */

/** URL host reserved for desktop share deep links. Mobile OAuth owns `auth`. */
export const DESKTOP_SHARE_DEEP_LINK_HOST = 'share';

/**
 * A named external capability a shared skill references (names only — never
 * configuration). Mirrors the web extractor's `SkillDependency` shape.
 */
export interface PublicShareSkillDependency {
  kind: 'mcp' | 'plugin';
  name: string;
}

/** Metadata only: discovery never downloads or activates a skill. */
export interface PublisherSkillSummary {
  externalId: string;
  name: string;
  description: string;
  publisher: string;
}

export interface PublisherSkillCatalog {
  skills: PublisherSkillSummary[];
}

export interface SkillPublisherProvenance {
  name: string;
  sourceUrl: string;
  license: string | null;
  pluginName: string;
}

/**
 * Anonymous pinned-snapshot views of a public share, served by the web
 * public-share resolve endpoints (see {@link publicShareSnapshotApiPath}) and
 * rendered by the desktop deep-link landing surface. These carry the share
 * row's pinned content — never the live entity — so the desktop shows exactly
 * the version the share page showed.
 */
export interface PublicSkillShareSnapshot {
  publisher?: SkillPublisherProvenance;
  /** Authenticated scoped fallback; main reauthorizes on install. */
  sourceRemoteId?: string;
  entity: 'skill';
  externalId: string;
  name: string;
  description: string;
  rawSkill: string;
  contentHash: string;
  dependencies: PublicShareSkillDependency[];
  /**
   * How much of the skill travels, mirroring
   * {@link PublicPipelineShareSnapshot}. Absent means definition-only, which
   * is every share published before skills carried packages.
   */
  distributionMode?: PipelineDistributionMode;
  package?: PipelinePackageSummary;
  /**
   * True when the skill was resolved through the authenticated team or
   * organization fallback rather than a public share. Its package then hangs
   * off the skill itself, not a public share, so the install has to read it
   * through the owned-skill endpoints; the public ones 404 for it. Absent means
   * a public share.
   */
  scopedShare?: boolean;
  authorUsername: string | null;
  updatedAt: string;
}

export interface PublicPipelineShareSnapshot {
  /** Authenticated scoped fallback; host must reauthorize before installing. */
  sourceRemoteId?: string;
  entity: 'pipeline';
  externalId: string;
  name: string;
  description: string;
  rawPipeline: string;
  contentHash: string;
  distributionMode?: PipelineDistributionMode;
  package?: PipelinePackageSummary;
  authorUsername: string | null;
  updatedAt: string;
}

export interface PublicPluginShareSnapshot {
  entity: 'plugin';
  externalId: string;
  name: string;
  description: string | null;
  ref: ShareablePluginRef;
  refKey: string;
  marketplaceOrigin: string;
  authorUsername: string | null;
  updatedAt: string;
}

export interface PublicAgentShareSnapshot {
  /** Authenticated scoped source; main re-fetches it when installing. */
  sourceRemoteId?: string;
  entity: 'agent';
  externalId: string;
  agent: SharedAgentDocument;
  contentHash: string;
  distributionMode?: PipelineDistributionMode;
  package?: PipelinePackageSummary;
  authorUsername: string | null;
  updatedAt: string;
}

export interface PublicWorkspaceTemplateShareSnapshot {
  entity: 'workspace';
  externalId: string;
  template: SharedWorkspaceTemplateDocument;
  contentHash: string;
  distributionMode?: PipelineDistributionMode;
  package?: PipelinePackageSummary;
  /** Pinned packages for custom skills embedded by a web-built Blueprint. */
  skillPackages?: Array<{
    clientKey: string;
    package: PipelinePackageSummary;
  }>;
  authorUsername: string | null;
  updatedAt: string;
}

export interface PublicCollectionShareSnapshot {
  entity: 'collection';
  externalId: string;
  collection: SharedCollectionDocument;
  contentHash: string;
  itemCounts: SharedCollectionItemCounts;
  customSkills: Array<{
    id: string;
    name: string;
    rawSkill: string;
    contentHash: string;
  }>;
  distributionMode?: PipelineDistributionMode;
  package?: PipelinePackageSummary;
  authorUsername: string | null;
  updatedAt: string;
}

export interface PublicAutomationShareSnapshot {
  entity: 'automation';
  externalId: string;
  /** Present when this snapshot came from the curated catalog, not a share. */
  sourceKind?: 'curated';
  automation: SharedAutomationDocument;
  contentHash: string;
  distributionMode?: PipelineDistributionMode;
  package?: PipelinePackageSummary;
  authorUsername: string | null;
  updatedAt: string;
}

export type PublicShareSnapshot =
  | PublicSkillShareSnapshot
  | PublicPipelineShareSnapshot
  | PublicPluginShareSnapshot
  | PublicAgentShareSnapshot
  | PublicWorkspaceTemplateShareSnapshot
  | PublicCollectionShareSnapshot
  | PublicAutomationShareSnapshot;

/**
 * API path for the anonymous pinned-snapshot resolve of a public share.
 * `apiNamespace` is the brand's `web.apiNamespace` (e.g. `desktop-app`).
 */
export function publicShareSnapshotApiPath(
  apiNamespace: string,
  entity: DesktopShareDeepLinkEntity,
  externalId: string,
): string {
  // The API wire vocabulary remains `workspaces`; only user-visible share and
  // desktop deep-link paths use the Blueprint naming.
  const segment =
    entity === 'workspace' ? 'workspaces' : pathSegmentForEntity(entity);
  return `/api/v1/${apiNamespace}/public-shares/${segment}/${encodeURIComponent(
    externalId,
  )}`;
}

/** Upper bound on accepted deep-link URLs; anything longer is dropped. */
export const DESKTOP_SHARE_DEEP_LINK_MAX_LENGTH = 2048;

export type DesktopShareDeepLinkEntity =
  | 'skill'
  | 'pipeline'
  | 'plugin'
  | 'agent'
  | 'workspace'
  | 'collection'
  | 'automation'
  | 'shared-container';

/**
 * Closed intent enum (CAN-2361 v2): `install` drives the save flow; `try`
 * (PR2b) auto-stages the example task when the arrival detection finds the
 * pinned version already installed — a prefilled composer draft for skills,
 * a preselected dispatch modal for pipelines; staging only, never an
 * auto-submit or auto-run. A `try` arrival for a NOT-installed entity
 * degrades to the same Install review state as the default intent.
 * Absent/invalid values default to `install` — never rejected, never echoed.
 *
 * FUTURE SEAM (do not build yet): when web cowork lands, this handling
 * reworks to web-first or a run-in-web vs desktop dropdown; the closed enum
 * here is the single place a new destination value would enter the contract.
 */
export type DesktopShareDeepLinkIntent = 'install' | 'try';

/** Closed attribution-source enum; invalid values are dropped, not rejected. */
export type DesktopShareDeepLinkSource = 'web_share_page';

/** Share audience carried across the web-to-desktop handoff funnel. */
export type DesktopShareDeepLinkAudience = 'PUBLIC' | 'TEAM' | 'ORGANIZATION';

const DEEP_LINK_INTENTS: readonly DesktopShareDeepLinkIntent[] = [
  'install',
  'try',
];
const DEEP_LINK_SOURCES: readonly DesktopShareDeepLinkSource[] = [
  'web_share_page',
];
const DEEP_LINK_AUDIENCES: readonly DesktopShareDeepLinkAudience[] = [
  'PUBLIC',
  'TEAM',
  'ORGANIZATION',
];

export interface DesktopShareDeepLink {
  entity: DesktopShareDeepLinkEntity;
  /** The shared entity UUID, or a validated curated Automation key. */
  externalId: string;
  intent: DesktopShareDeepLinkIntent;
  source?: DesktopShareDeepLinkSource;
  /** Omitted for legacy/public links; consumers default absence to PUBLIC. */
  audience?: DesktopShareDeepLinkAudience;
  packageVersion?: DesktopShareDeepLinkPackageVersion;
  expectedPipelineContentHash?: string;
  expectedDistributionMode?: PipelineDistributionMode;
  expectedPackageDigest?: string;
  expectedWorkspaceTemplateContentHash?: string;
  expectedCollectionContentHash?: string;
  expectedAutomationContentHash?: string;
  /** Narrows a non-UUID Automation id to the curated catalog namespace. */
  automationSource?: 'curated';
}

/** Validated desktop navigation target opened from the browser pairing flow. */
export interface DesktopRemoteControlDeepLink {
  destination: 'remote-control';
}

/**
 * Validated desktop Settings section opened from the web. Only Privacy is
 * linkable: the web Personal project list points there so the user can turn
 * on "Show my Personal projects on the web".
 */
export interface DesktopSettingsDeepLink {
  destination: 'settings';
  section: 'privacy';
  optIn?: { feature: DataSharingOptInFeature; organizationId: string };
}

/** Every custom-scheme payload the desktop app accepts from the OS. */
export type DesktopDeepLink =
  | DesktopShareDeepLink
  | DesktopRemoteControlDeepLink
  | DesktopSettingsDeepLink
  | DesktopOrgProjectDeepLink;

/**
 * Same scheme-safety shape `scripts/brand/generate-mobile-brand.mjs` enforces
 * for the mobile OAuth callback scheme, and `scripts/brand/validate-brands.mjs`
 * enforces for every brand `internalName`.
 */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;

/** Builds the browser-to-desktop link for the Remote Control modal. */
export function buildDesktopRemoteControlDeepLink(scheme: string): string {
  if (!SCHEME_PATTERN.test(scheme)) {
    throw new Error(
      `Invalid desktop deep-link scheme (must match ${String(SCHEME_PATTERN)})`,
    );
  }
  return `${scheme}://remote-control`;
}

/**
 * Parses the exact Remote Control destination without accepting params or
 * path suffixes that could accidentally broaden the custom-scheme surface.
 */
export function parseDesktopRemoteControlDeepLink(
  rawUrl: string,
  scheme: string,
): DesktopRemoteControlDeepLink | null {
  if (!SCHEME_PATTERN.test(scheme)) return null;
  if (rawUrl !== buildDesktopRemoteControlDeepLink(scheme)) return null;
  return { destination: 'remote-control' };
}

/** Builds the browser-to-desktop link that opens Settings → Privacy. */
export function buildDesktopPrivacySettingsDeepLink(scheme: string): string {
  if (!SCHEME_PATTERN.test(scheme)) {
    throw new Error(
      `Invalid desktop deep-link scheme (must match ${String(SCHEME_PATTERN)})`,
    );
  }
  return `${scheme}://settings/privacy`;
}

/** Builds a review request; receipt never authorizes a preference write. */
export function buildDesktopPrivacyOptInDeepLink(
  scheme: string,
  input: { feature: DataSharingOptInFeature; organizationId: string },
): string {
  const base = buildDesktopPrivacySettingsDeepLink(scheme);
  if (
    !isDataSharingOptInFeature(input.feature) ||
    !PRIVACY_UUID_PATTERN.test(input.organizationId)
  ) {
    throw new Error('Invalid privacy opt-in request');
  }
  return `${base}?feature=${input.feature}&org=${input.organizationId.toLowerCase()}`;
}
const PRIVACY_UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Canonical lowercase scheme/authority; reject raw syntax URL would normalize. */
export function parseDesktopSettingsDeepLink(
  rawUrl: string,
  scheme: string,
): DesktopSettingsDeepLink | null {
  if (!SCHEME_PATTERN.test(scheme) || rawUrl.length > 256) return null;
  const base = buildDesktopPrivacySettingsDeepLink(scheme);
  if (rawUrl !== base && !rawUrl.startsWith(`${base}?`)) return null;
  if (rawUrl.includes('#') || rawUrl === `${base}?` || /[\s\\]/.test(rawUrl))
    return null;
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== `${scheme}:` ||
      url.host !== 'settings' ||
      url.pathname !== '/privacy' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      return null;
    if (rawUrl === base) return { destination: 'settings', section: 'privacy' };
    const entries = Array.from(url.searchParams.entries());
    if (
      entries.length !== 2 ||
      url.searchParams.getAll('feature').length !== 1 ||
      url.searchParams.getAll('org').length !== 1
    )
      return null;
    const feature = url.searchParams.get('feature');
    const organizationId = url.searchParams.get('org');
    if (
      !isDataSharingOptInFeature(feature) ||
      !organizationId ||
      !PRIVACY_UUID_PATTERN.test(organizationId)
    )
      return null;
    return {
      destination: 'settings',
      section: 'privacy',
      optIn: { feature, organizationId: organizationId.toLowerCase() },
    };
  } catch {
    return null;
  }
}

// Entity segments are matched case-sensitively (machine-built links are
// lowercase); only the UUID hex digits tolerate case, normalized on output.
const SHARE_DEEP_LINK_PATH_PATTERN =
  /^\/(?:(skills|pipelines|plugins|agents|project-templates|blueprints|workspaces|collections|automations)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})|(shared-container)\/([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]))$/;
const CURATED_AUTOMATION_DEEP_LINK_PATH_PATTERN =
  /^\/automations\/([^/]{1,64})$/;

function entityForPathSegment(segment: string): DesktopShareDeepLinkEntity {
  if (segment === 'shared-container') return 'shared-container';
  if (segment === 'skills') return 'skill';
  if (segment === 'plugins') return 'plugin';
  if (segment === 'agents') return 'agent';
  if (segment === 'automations') return 'automation';
  if (segment === 'collections') return 'collection';
  if (
    segment === 'project-templates' ||
    segment === 'blueprints' ||
    segment === 'workspaces'
  )
    return 'workspace';
  return 'pipeline';
}

function pathSegmentForEntity(entity: DesktopShareDeepLinkEntity): string {
  if (entity === 'shared-container') return 'shared-container';
  if (entity === 'skill') return 'skills';
  if (entity === 'plugin') return 'plugins';
  if (entity === 'agent') return 'agents';
  if (entity === 'automation') return 'automations';
  if (entity === 'collection') return 'collections';
  if (entity === 'workspace') return 'project-templates';
  return 'pipelines';
}

/**
 * Builds a desktop share deep link. Throws on invalid input — callers pass
 * server-derived values, so a failure here is a programming error, not user
 * input.
 */
export function buildDesktopShareDeepLink(input: {
  scheme: string;
  entity: DesktopShareDeepLinkEntity;
  externalId: string;
  /** Omitted for the default `install` intent, keeping URLs minimal. */
  intent?: DesktopShareDeepLinkIntent;
  source?: DesktopShareDeepLinkSource;
  audience?: DesktopShareDeepLinkAudience;
  packageVersion?: DesktopShareDeepLinkPackageVersion;
  expectedPipelineContentHash?: string;
  expectedDistributionMode?: PipelineDistributionMode;
  expectedPackageDigest?: string;
  expectedWorkspaceTemplateContentHash?: string;
  expectedCollectionContentHash?: string;
  expectedAutomationContentHash?: string;
  automationSource?: 'curated';
}): string {
  if (!SCHEME_PATTERN.test(input.scheme)) {
    throw new Error(
      `Invalid desktop deep-link scheme (must match ${String(SCHEME_PATTERN)})`,
    );
  }
  const curatedAutomation = input.automationSource === 'curated';
  if (
    input.automationSource !== undefined &&
    (input.entity !== 'automation' ||
      !curatedAutomation ||
      !isCuratedCatalogKey(input.externalId))
  ) {
    throw new Error('Invalid curated automation deep link');
  }
  const externalId =
    input.entity === 'shared-container' || curatedAutomation
      ? input.externalId
      : input.externalId.toLowerCase();
  const path = `/${pathSegmentForEntity(input.entity)}/${externalId}`;
  if (!curatedAutomation && !SHARE_DEEP_LINK_PATH_PATTERN.test(path)) {
    throw new Error('Invalid share externalId (must be a canonical UUID)');
  }
  const query = new URLSearchParams();
  if (input.intent !== undefined && input.intent !== 'install') {
    query.set('intent', input.intent);
  }
  if (input.source !== undefined) {
    query.set('source', input.source);
  }
  if (curatedAutomation) {
    query.set('automationSource', 'curated');
  }
  if (input.audience !== undefined && input.audience !== 'PUBLIC') {
    query.set('audience', input.audience);
  }
  const pin = parseInstallPin(input.entity, {
    packageVersion: input.packageVersion,
    expectedPipelineContentHash: input.expectedPipelineContentHash,
    expectedCollectionContentHash: input.expectedCollectionContentHash,
    expectedDistributionMode: input.expectedDistributionMode,
    expectedPackageDigest: input.expectedPackageDigest,
  });
  if (pin === null) throw new Error('Invalid pipeline share install pin');
  if (pin.expectedPipelineContentHash !== undefined)
    query.set('expectedPipelineContentHash', pin.expectedPipelineContentHash);
  if (pin.expectedCollectionContentHash !== undefined)
    query.set(
      'expectedCollectionContentHash',
      pin.expectedCollectionContentHash,
    );
  if (pin.expectedDistributionMode !== undefined)
    query.set('expectedDistributionMode', pin.expectedDistributionMode);
  if (pin.packageVersion !== undefined)
    query.set('packageVersion', String(pin.packageVersion));
  if (pin.expectedPackageDigest !== undefined)
    query.set('expectedPackageDigest', pin.expectedPackageDigest);
  if (input.expectedWorkspaceTemplateContentHash !== undefined) {
    if (
      input.entity !== 'workspace' ||
      !isWorkspaceTemplateContentHash(
        input.expectedWorkspaceTemplateContentHash,
      )
    ) {
      throw new Error('Invalid workspace template share install pin');
    }
    query.set(
      'expectedWorkspaceTemplateContentHash',
      input.expectedWorkspaceTemplateContentHash,
    );
  }
  if (input.expectedAutomationContentHash !== undefined) {
    if (
      input.entity !== 'automation' ||
      !isSharedAutomationContentHash(input.expectedAutomationContentHash)
    ) {
      throw new Error('Invalid automation share install pin');
    }
    query.set(
      'expectedAutomationContentHash',
      input.expectedAutomationContentHash,
    );
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return `${input.scheme}://${DESKTOP_SHARE_DEEP_LINK_HOST}${path}${suffix}`;
}

/**
 * Parses and validates an untrusted deep-link URL for the given brand scheme.
 *
 * Returns `null` — never throws — unless ALL of the following hold:
 * bounded length; exact scheme match; host exactly `share` (lowercase; these
 * links are machine-built by {@link buildDesktopShareDeepLink}, so a cased
 * host is treated as hostile input rather than normalized); no userinfo, no
 * port, no fragment; path is exactly one known entity segment plus one
 * canonical-UUID id, except for an Automation path explicitly narrowed to a
 * validated curated catalog key. Query params use closed enums; everything
 * else is dropped unread for forward compatibility.
 *
 * The returned object is the only thing allowed to cross process boundaries;
 * the raw URL string stays with the caller and must never be logged, sent
 * over IPC, or navigated.
 */
export function parseDesktopShareDeepLink(
  rawUrl: string,
  scheme: string,
): DesktopShareDeepLink | null {
  if (!SCHEME_PATTERN.test(scheme)) return null;
  if (rawUrl.length === 0 || rawUrl.length > DESKTOP_SHARE_DEEP_LINK_MAX_LENGTH)
    return null;

  // The WHATWG parser normalizes dot-segments (`share/skills/../pipelines/x`
  // parses to `/pipelines/x`) and decodes percent-escapes before the path
  // check below could see them. Machine-built links contain neither, so any
  // occurrence ahead of the query string is hostile input, not something to
  // normalize.
  const preQuery = rawUrl.split('?', 1)[0] ?? rawUrl;
  if (/%|(?:^|[/\\])\.\.?(?:[/\\]|$)/.test(preQuery)) return null;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  // The WHATWG parser lowercases the protocol but preserves case in opaque
  // (non-special-scheme) hosts, so the host comparison below is exact.
  if (url.protocol !== `${scheme}:`) return null;
  if (url.host !== DESKTOP_SHARE_DEEP_LINK_HOST) return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.port !== '') return null;
  if (url.hash !== '') return null;

  const automationSourceParams = url.searchParams.getAll('automationSource');
  if (automationSourceParams.length > 1) return null;
  const automationSource = automationSourceParams[0];
  if (automationSource !== undefined && automationSource !== 'curated') {
    return null;
  }
  const curatedMatch =
    automationSource === 'curated'
      ? CURATED_AUTOMATION_DEEP_LINK_PATH_PATTERN.exec(url.pathname)
      : null;
  const shareMatch =
    automationSource === undefined
      ? SHARE_DEEP_LINK_PATH_PATTERN.exec(url.pathname)
      : null;
  const segment = curatedMatch
    ? 'automations'
    : (shareMatch?.[1] ?? shareMatch?.[3]);
  const externalId = curatedMatch?.[1] ?? shareMatch?.[2] ?? shareMatch?.[4];
  if (segment === undefined || externalId === undefined) return null;
  if (curatedMatch && !isCuratedCatalogKey(externalId)) return null;

  const intentParam = url.searchParams.get('intent');
  const intent =
    DEEP_LINK_INTENTS.find((allowed) => allowed === intentParam) ?? 'install';
  const sourceParam = url.searchParams.get('source');
  const source = DEEP_LINK_SOURCES.find((allowed) => allowed === sourceParam);
  const audienceParam = url.searchParams.get('audience');
  const audience = DEEP_LINK_AUDIENCES.find(
    (allowed) => allowed === audienceParam,
  );

  const pinKeys = [
    'packageVersion',
    'expectedPipelineContentHash',
    'expectedCollectionContentHash',
    'expectedDistributionMode',
    'expectedPackageDigest',
  ] as const;
  if (pinKeys.some((key) => url.searchParams.getAll(key).length > 1))
    return null;
  const packageVersion = parsePipelinePackageClientVersion(
    url.searchParams.get('packageVersion'),
  );
  if (packageVersion === 'invalid') return null;
  const pin = parseInstallPin(entityForPathSegment(segment), {
    packageVersion,
    expectedPipelineContentHash:
      url.searchParams.get('expectedPipelineContentHash') ?? undefined,
    expectedCollectionContentHash:
      url.searchParams.get('expectedCollectionContentHash') ?? undefined,
    expectedDistributionMode:
      url.searchParams.get('expectedDistributionMode') ?? undefined,
    expectedPackageDigest:
      url.searchParams.get('expectedPackageDigest') ?? undefined,
  });
  if (pin === null) return null;
  const workspaceHashParams = url.searchParams.getAll(
    'expectedWorkspaceTemplateContentHash',
  );
  if (workspaceHashParams.length > 1) return null;
  const expectedWorkspaceTemplateContentHash = workspaceHashParams[0];
  if (
    expectedWorkspaceTemplateContentHash !== undefined &&
    ((segment !== 'project-templates' &&
      segment !== 'blueprints' &&
      segment !== 'workspaces') ||
      !isWorkspaceTemplateContentHash(expectedWorkspaceTemplateContentHash))
  ) {
    return null;
  }
  const automationHashParams = url.searchParams.getAll(
    'expectedAutomationContentHash',
  );
  if (automationHashParams.length > 1) return null;
  const expectedAutomationContentHash = automationHashParams[0];
  if (
    expectedAutomationContentHash !== undefined &&
    (segment !== 'automations' ||
      !isSharedAutomationContentHash(expectedAutomationContentHash))
  ) {
    return null;
  }

  return {
    entity: entityForPathSegment(segment),
    externalId:
      segment === 'shared-container' ? externalId : externalId.toLowerCase(),
    intent,
    ...(source !== undefined ? { source } : {}),
    ...(audience !== undefined && audience !== 'PUBLIC' ? { audience } : {}),
    ...pin,
    ...(expectedWorkspaceTemplateContentHash === undefined
      ? {}
      : { expectedWorkspaceTemplateContentHash }),
    ...(expectedAutomationContentHash === undefined
      ? {}
      : { expectedAutomationContentHash }),
    ...(automationSource === undefined ? {} : { automationSource }),
  };
}

type InstallPinFields = Pick<
  DesktopShareDeepLink,
  | 'packageVersion'
  | 'expectedPipelineContentHash'
  | 'expectedCollectionContentHash'
  | 'expectedDistributionMode'
  | 'expectedPackageDigest'
>;

function parseInstallPin(
  entity: DesktopShareDeepLinkEntity,
  fields: Omit<InstallPinFields, 'expectedDistributionMode'> & {
    expectedDistributionMode?: string;
  },
): InstallPinFields | null {
  const hasAny = Object.values(fields).some((value) => value !== undefined);
  if (!hasAny) return {};
  if (entity !== 'pipeline' && entity !== 'collection') return null;
  if (
    (entity === 'collection' &&
      fields.expectedPipelineContentHash !== undefined) ||
    (entity === 'pipeline' &&
      fields.expectedCollectionContentHash !== undefined)
  )
    return null;
  const contentHash =
    entity === 'collection'
      ? fields.expectedCollectionContentHash
      : fields.expectedPipelineContentHash;
  if (!isPipelineContentHash(contentHash)) return null;
  const hashFields =
    entity === 'collection'
      ? { expectedCollectionContentHash: contentHash }
      : { expectedPipelineContentHash: contentHash };
  // Keep hash-only collection links emitted before package pins were supported.
  if (
    entity === 'collection' &&
    fields.expectedDistributionMode === undefined &&
    fields.packageVersion === undefined &&
    fields.expectedPackageDigest === undefined
  )
    return hashFields;
  if (fields.expectedDistributionMode === 'definition_only') {
    if (
      fields.packageVersion !== undefined ||
      fields.expectedPackageDigest !== undefined
    )
      return null;
    return {
      ...hashFields,
      expectedDistributionMode: 'definition_only',
    };
  }
  if (
    fields.expectedDistributionMode !== 'package' ||
    fields.packageVersion === undefined ||
    !isDesktopShareDeepLinkPackageVersion(fields.packageVersion) ||
    !isPipelinePackageDigest(fields.expectedPackageDigest)
  )
    return null;
  return {
    packageVersion: fields.packageVersion,
    ...hashFields,
    expectedDistributionMode: 'package',
    expectedPackageDigest: fields.expectedPackageDigest,
  };
}

function parsePipelinePackageClientVersion(
  value: string | null,
): DesktopShareDeepLink['packageVersion'] | 'invalid' {
  if (value === null) return undefined;
  // Only the canonical decimal a builder emits. `Number()` alone accepted
  // `0x3`, `+3`, `3e0`, `03` and `1.0` as spellings of a valid version, in the
  // one parser whose rule is that machine-built links are never normalized.
  if (!/^[1-9][0-9]*$/.test(value)) return 'invalid';
  const parsed = Number(value);
  return isDesktopShareDeepLinkPackageVersion(parsed) ? parsed : 'invalid';
}

export interface DesktopOrgProjectDeepLink {
  destination: 'org-project';
  projectId: string;
  organizationId: string;
}

export function parseDesktopOrgProjectDeepLink(
  rawUrl: string,
  scheme: string,
): DesktopOrgProjectDeepLink | null {
  if (SCHEME_PATTERN.test(scheme) === false) return null;
  try {
    const url = new URL(rawUrl);
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const projectId = url.pathname.slice(1);
    const organizationId = url.searchParams.get('org');
    if (
      url.protocol !== `${scheme}:` ||
      url.hostname !== 'org-project' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.hash !== '' ||
      uuid.test(projectId) === false ||
      organizationId === null ||
      uuid.test(organizationId) === false ||
      Array.from(url.searchParams.keys()).length !== 1
    )
      return null;
    return {
      destination: 'org-project',
      projectId: projectId.toLowerCase(),
      organizationId: organizationId.toLowerCase(),
    };
  } catch {
    return null;
  }
}
