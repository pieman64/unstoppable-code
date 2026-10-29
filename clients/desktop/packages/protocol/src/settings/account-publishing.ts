// ---------------------------------------------------------------------------
// Moved verbatim from `apps/web/src/lib/profile/profile-publishing-contracts.ts`,
// which re-exports every symbol here. These are the authenticated management
// shapes for the account "Published work" manager; the public read DTOs live
// in `@canopy/protocol/profile`.
// ---------------------------------------------------------------------------

/** URL path segment for an artifact kind. */
export const PROFILE_ARTIFACT_PATH_KINDS = [
  'skills',
  'runs',
  'plans',
  'pipelines',
] as const;

export type ProfileArtifactPathKind =
  (typeof PROFILE_ARTIFACT_PATH_KINDS)[number];

export function isProfileArtifactPathKind(
  value: string,
): value is ProfileArtifactPathKind {
  const kinds: readonly string[] = PROFILE_ARTIFACT_PATH_KINDS;
  return kinds.includes(value);
}

/** One artifact the caller could publish, with its current publish state. */
export interface PublishableArtifactItem {
  /** Source externalId (uuid). */
  id: string;
  title: string;
  updatedAt: string;
  published: boolean;
  publishedAt: string | null;
  /** True when the source was edited after the pinned snapshot was taken. */
  publishedStale: boolean;
  /** Skills only: the `/s/skills/<id>` link, present when a public share exists. */
  sharePath?: string;
}

export interface ListPublishableArtifactsResponse {
  skills: PublishableArtifactItem[];
  runs: PublishableArtifactItem[];
  plans: PublishableArtifactItem[];
  pipelines: PublishableArtifactItem[];
}

/** Max results returned per picker search query. */
export const ARTIFACT_SEARCH_LIMIT = 20;

/**
 * Max artifacts a user may feature on their profile at once. Featured work is a
 * curated set (GitHub pinned-items pattern), and the public page renders every
 * featured card, so this both keeps the page sane and enforces curation. Shared
 * so the client can pre-empt the server's hard limit in the UI.
 */
export const MAX_FEATURED_ARTIFACTS = 24;

/** Server error message when the featured-work limit is hit (client-matched). */
export const FEATURED_LIMIT_ERROR = `You can feature up to ${MAX_FEATURED_ARTIFACTS} items on your profile. Remove one to add another.`;

/** One currently-published listing on the caller's profile. */
export interface PublishedProfileArtifactItem {
  kind: ProfileArtifactPathKind;
  /** Source externalId (what the publish/unpublish endpoints address). */
  id: string;
  title: string;
  publishedAt: string;
  /** True when the source was edited after the pinned snapshot was taken. */
  publishedStale: boolean;
  /** Skills only: the `/s/skills/<id>` link. */
  sharePath?: string;
}

/** Published-only listing for the Featured work manager. */
export interface ListPublishedProfileArtifactsResponse {
  items: PublishedProfileArtifactItem[];
}

/** One kind's search results for the Add work picker. */
export interface SearchPublishableArtifactsResponse {
  items: PublishableArtifactItem[];
}
