/**
 * Renderer helpers for turning a shared resource's server id into a shareable
 * Canopy Cloud URL. The cloud base URL lives main-side (`getCanopyCloudBaseUrl`,
 * bundled at build time) and is exposed to the renderer through
 * `window.api.getCanopyCloudBaseUrl`. Each resolver is best-effort: when the
 * base URL is not configured (e.g. an unconfigured local build) it returns
 * `null` so callers simply omit the "Copy link" affordance rather than
 * surfacing a broken link.
 */

import type { ShareDialogLink } from '@canopy/ui-app/sharing';

export const AGENT_PUBLIC_SHARE_CHANGED_EVENT =
  'canopy:agent-public-share-changed';

async function resolveCloudBaseUrl(): Promise<string | null> {
  if (typeof window.api?.getCanopyCloudBaseUrl !== 'function') {
    return null;
  }
  try {
    const base = await window.api.getCanopyCloudBaseUrl();
    if (!base) {
      return null;
    }
    // Strip any trailing slashes so the joined path never doubles up.
    const trimmed = base.replace(/\/+$/, '');
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Shareable web URL for a shared run (session). `externalId` is the
 * server-minted `SharedRun.externalId`; the web route is `/runs/{externalId}`.
 */
export async function resolveSharedRunUrl(
  externalId: string,
): Promise<string | null> {
  const base = await resolveCloudBaseUrl();
  return base ? `${base}/runs/${encodeURIComponent(externalId)}` : null;
}

/**
 * Shareable web URL for a shared plan. `remoteId` is the server-generated
 * external id of the shared-plan copy (`TrackedPlanShareState.remoteId`); the
 * web route is `/plans/{remoteId}`.
 */
export async function resolveSharedPlanUrl(
  remoteId: string,
): Promise<string | null> {
  const base = await resolveCloudBaseUrl();
  return base ? `${base}/plans/${encodeURIComponent(remoteId)}` : null;
}

/**
 * Shareable web URL for a public shared skill. `sharePath` is the server-minted
 * path returned with `SharedSkillPublicShareInfo`.
 */
export async function resolveSharedSkillUrl(
  sharePath: string,
): Promise<string | null> {
  const base = await resolveCloudBaseUrl();
  if (!base) return null;
  const normalizedPath = sharePath.startsWith('/')
    ? sharePath
    : `/${sharePath}`;
  return `${base}${normalizedPath}`;
}

/**
 * Shareable web URL for a shared container's capability link. `linkPath` is
 * the server-returned path (`SharedContainerLink.url`); the renderer never
 * builds it, so the token format stays server-owned.
 */
export async function resolveSharedContainerLinkUrl(
  linkPath: string,
): Promise<string | null> {
  return resolveSharedSkillUrl(linkPath);
}

export async function resolveSharedPipelineUrl(
  sharePath: string,
): Promise<string | null> {
  return resolveSharedSkillUrl(sharePath);
}

export async function resolveSharedPluginUrl(
  sharePath: string,
): Promise<string | null> {
  return resolveSharedSkillUrl(sharePath);
}

export async function resolveSharedAgentUrl(
  sharePath: string,
): Promise<string | null> {
  return resolveSharedSkillUrl(sharePath);
}

export const AUTOMATION_PUBLIC_SHARE_CHANGED_EVENT =
  'canopy:automation-public-share-changed';

export async function resolveSharedAutomationUrl(
  sharePath: string,
): Promise<string | null> {
  return resolveSharedSkillUrl(sharePath);
}

/** Where a shared resource's link points, before URL resolution. */
export type ShareLinkSource =
  | { readonly kind: 'public'; readonly sharePath: string }
  | { readonly kind: 'scoped'; readonly id: string };

/** The fields of a shared-resource detail that decide its current link. */
export interface ShareLinkDetail {
  readonly id: string;
  readonly shareScope?: string;
  readonly publicShare?: { readonly sharePath: string } | null;
}

/** Per-resource link derivation shared by a host's `share()` and its dialog. */
export interface ShareLinkResolver {
  /**
   * The link a share just produced. Falls back to the server-minted path when
   * the cloud base URL is not configured, so the link is still copyable.
   */
  readonly resolveLink: (source: ShareLinkSource) => Promise<ShareDialogLink>;
  /**
   * The resource's current link, for the share dialog's Copy link: the public
   * link when there is one (anyone can open it), else the member-only link of
   * a team or organization share, else none.
   */
  readonly linkFromDetail: (
    detail: ShareLinkDetail,
  ) => Promise<ShareDialogLink | null>;
}

/**
 * Builds a resource's {@link ShareLinkResolver} from its scoped share path and
 * URL resolver. A host's `share()` and its existing-share link both go through
 * it, so the link the toast carries and the one Copy link copies can't drift.
 */
export function createShareLinkResolver(
  scopedSharePath: (id: string) => string,
  resolveUrl: (sharePath: string) => Promise<string | null>,
): ShareLinkResolver {
  const resolveLink = async (
    source: ShareLinkSource,
  ): Promise<ShareDialogLink> => {
    const path =
      source.kind === 'public' ? source.sharePath : scopedSharePath(source.id);
    return { url: (await resolveUrl(path)) ?? path, kind: source.kind };
  };
  const linkFromDetail = async (
    detail: ShareLinkDetail,
  ): Promise<ShareDialogLink | null> => {
    const source: ShareLinkSource | null = detail.publicShare
      ? { kind: 'public', sharePath: detail.publicShare.sharePath }
      : detail.shareScope === 'team' || detail.shareScope === 'organization'
        ? { kind: 'scoped', id: detail.id }
        : null;
    if (source === null) return null;
    const path =
      source.kind === 'public' ? source.sharePath : scopedSharePath(source.id);
    // Existing-share controls appear only once an absolute browser URL is
    // resolved. A just-created share may safely carry the server path as a
    // fallback, but reopening must never flash a path-only Copy link.
    const url = await resolveUrl(path);
    return url ? { url, kind: source.kind } : null;
  };
  return { resolveLink, linkFromDetail };
}
