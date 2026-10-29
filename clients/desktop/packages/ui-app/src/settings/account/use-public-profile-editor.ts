'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  USERNAME_TAKEN_ERROR,
  type PublicProfileSettings,
  type UpdatePublicProfileRequest,
  type UsernameAvailabilityResponse,
  type UsernameUnavailableReason,
} from '@canopy/protocol/settings/account';
import {
  FEATURED_LIMIT_ERROR,
  PROFILE_ARTIFACT_PATH_KINDS,
  type ListPublishableArtifactsResponse,
  type ListPublishedProfileArtifactsResponse,
  type ProfileArtifactPathKind,
  type PublishableArtifactItem,
  type PublishedProfileArtifactItem,
  type SearchPublishableArtifactsResponse,
} from '@canopy/protocol/settings/account-publishing';
import type {
  PublicProfileArtifactDetail,
  SharedRunRollup,
  SocialLink,
} from '@canopy/protocol/profile';
import { useSettingsClient } from '../host';
import { useSettingsErrorCopy, type KnownSettingsError } from '../errors';

/** Failures of the public profile save that have their own copy. */
const SAVE_PUBLIC_PROFILE_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  { status: 409, copy: USERNAME_TAKEN_ERROR },
];

/**
 * Failures of featuring work that have their own copy, matched by the
 * publish route's `code`.
 */
const PUBLISH_ARTIFACT_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  { status: 409, serverCode: 'featured_limit', copy: FEATURED_LIMIT_ERROR },
  {
    status: 409,
    serverCode: 'skill_not_private',
    copy: 'Move this skill to Private before adding it to your profile.',
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSocialLink(value: unknown): value is SocialLink {
  return (
    isRecord(value) &&
    typeof value.platform === 'string' &&
    typeof value.url === 'string'
  );
}

function isPublicProfileSettings(
  value: unknown,
): value is PublicProfileSettings {
  return (
    isRecord(value) &&
    (value.username === null || typeof value.username === 'string') &&
    typeof value.enabled === 'boolean' &&
    (value.bio === null || typeof value.bio === 'string') &&
    Array.isArray(value.links) &&
    value.links.every(isSocialLink) &&
    typeof value.showCost === 'boolean' &&
    typeof value.showHeatmap === 'boolean'
  );
}

function parseSettingsResponse(value: unknown): PublicProfileSettings | null {
  if (!isRecord(value) || !('settings' in value)) {
    return null;
  }
  const settings = value.settings;
  return settings !== null && isPublicProfileSettings(settings)
    ? settings
    : null;
}

function isAvailabilityResponse(
  value: unknown,
): value is UsernameAvailabilityResponse {
  if (!isRecord(value) || typeof value.available !== 'boolean') {
    return false;
  }
  if (!('reason' in value) || value.reason === undefined) {
    return true;
  }
  const reasons: readonly UsernameUnavailableReason[] = [
    'invalid',
    'reserved',
    'taken',
  ];
  return (
    typeof value.reason === 'string' &&
    reasons.some((reason) => reason === value.reason)
  );
}

function isArtifactItem(value: unknown): value is PublishableArtifactItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.published === 'boolean' &&
    (value.publishedAt === null || typeof value.publishedAt === 'string') &&
    typeof value.publishedStale === 'boolean'
  );
}

function isListArtifactsResponse(
  value: unknown,
): value is ListPublishableArtifactsResponse {
  if (!isRecord(value)) {
    return false;
  }
  const lists = [value.skills, value.runs, value.plans, value.pipelines];
  return lists.every(
    (list) => Array.isArray(list) && list.every(isArtifactItem),
  );
}

function isPublishedItem(
  value: unknown,
): value is PublishedProfileArtifactItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.publishedAt === 'string' &&
    typeof value.publishedStale === 'boolean' &&
    typeof value.kind === 'string' &&
    PROFILE_ARTIFACT_PATH_KINDS.some((kind) => kind === value.kind)
  );
}

function isPublishedListResponse(
  value: unknown,
): value is ListPublishedProfileArtifactsResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isPublishedItem)
  );
}

function isSearchResponse(
  value: unknown,
): value is SearchPublishableArtifactsResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isArtifactItem)
  );
}

function isSharedRunRollup(value: unknown): value is SharedRunRollup {
  return (
    isRecord(value) &&
    typeof value.inputTokens === 'number' &&
    typeof value.outputTokens === 'number' &&
    typeof value.cacheReadInputTokens === 'number' &&
    typeof value.cacheCreationInputTokens === 'number' &&
    typeof value.totalCostUsd === 'number' &&
    typeof value.toolUseCount === 'number' &&
    typeof value.turnCount === 'number' &&
    typeof value.provider === 'string' &&
    typeof value.status === 'string'
  );
}

function isArtifactDetail(
  value: unknown,
): value is PublicProfileArtifactDetail {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.publishedAt !== 'string'
  ) {
    return false;
  }
  if (value.kind === 'run') {
    return typeof value.summary === 'string' && isSharedRunRollup(value.rollup);
  }
  if (value.kind === 'plan') {
    return typeof value.content === 'string';
  }
  if (value.kind === 'pipeline') {
    return (
      typeof value.description === 'string' &&
      typeof value.rawPipeline === 'string'
    );
  }
  return false;
}

function parsePreview(value: unknown): PublicProfileArtifactDetail | null {
  if (!isRecord(value) || !isArtifactDetail(value.preview)) {
    return null;
  }
  return value.preview;
}

export interface UsePublicProfileEditorResult {
  busy: boolean;
  error: string | null;
  clearError: () => void;
  /** PATCH settings; resolves to the saved settings, or null on failure. */
  save: (
    patch: UpdatePublicProfileRequest,
  ) => Promise<PublicProfileSettings | null>;
  /** Live availability check for a candidate username. */
  checkUsername: (
    username: string,
  ) => Promise<UsernameAvailabilityResponse | null>;
  /** List the caller's publishable artifacts across all four kinds. */
  listArtifacts: () => Promise<ListPublishableArtifactsResponse | null>;
  /** List only the caller's currently-published profile listings. */
  listPublished: () => Promise<ListPublishedProfileArtifactsResponse | null>;
  /** Per-kind title search over the caller's sources (Add work picker). */
  searchArtifacts: (
    kind: ProfileArtifactPathKind,
    query: string,
  ) => Promise<SearchPublishableArtifactsResponse | null>;
  /** Fetch the exact payload a publish would pin (run/plan/pipeline only). */
  previewArtifact: (
    kind: ProfileArtifactPathKind,
    sourceId: string,
  ) => Promise<PublicProfileArtifactDetail | null>;
  /** Publish (upsert) an artifact onto the profile. Resolves true on success. */
  publishArtifact: (
    kind: ProfileArtifactPathKind,
    sourceId: string,
  ) => Promise<boolean>;
  /** Unpublish an artifact listing. Resolves true on success. */
  unpublishArtifact: (
    kind: ProfileArtifactPathKind,
    sourceId: string,
  ) => Promise<boolean>;
  /**
   * Revoke a skill's public share link (kills the `/share/skills/...` link and
   * cascade-removes any profile listing). Distinct from unpublishing the
   * listing. Resolves true on success.
   */
  revokeSkillShare: (sourceId: string) => Promise<boolean>;
}

/**
 * Transport for the /account public-profile manager: settings PATCH, username
 * availability, and the four artifact operations (list / preview / publish /
 * unpublish). Separate from {@link useProfileEditor} — this owns the public
 * profile surface, not the global name/avatar identity.
 */
export function usePublicProfileEditor(): UsePublicProfileEditorResult {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy('settings.account.public-profile');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback((): void => {
    setError(null);
  }, []);

  const save = useCallback(
    async (
      patch: UpdatePublicProfileRequest,
    ): Promise<PublicProfileSettings | null> => {
      setBusy(true);
      setError(null);
      try {
        const settings = parseSettingsResponse(
          await client.write('account.profile.update', patch),
        );
        if (!settings) {
          setError(
            errorCopy.actionCopy(new Error('Invalid profile response'), {
              action: 'save your profile',
            }),
          );
          return null;
        }
        return settings;
      } catch (err: unknown) {
        setError(
          errorCopy.actionCopy(err, {
            action: 'save your profile',
            known: SAVE_PUBLIC_PROFILE_KNOWN_ERRORS,
          }),
        );
        return null;
      } finally {
        setBusy(false);
      }
    },
    [client, errorCopy],
  );

  const checkUsername = useCallback(
    async (username: string): Promise<UsernameAvailabilityResponse | null> => {
      try {
        const body: unknown = await client.read(
          'account.profile.usernameAvailability',
          { username },
        );
        return isAvailabilityResponse(body) ? body : null;
      } catch {
        return null;
      }
    },
    [client],
  );

  const listArtifacts =
    useCallback(async (): Promise<ListPublishableArtifactsResponse | null> => {
      try {
        const body: unknown = await client.read(
          'account.profile.artifacts.list',
          {},
        );
        return isListArtifactsResponse(body) ? body : null;
      } catch {
        return null;
      }
    }, [client]);

  const listPublished =
    useCallback(async (): Promise<ListPublishedProfileArtifactsResponse | null> => {
      try {
        const body: unknown = await client.read(
          'account.profile.artifacts.published',
          {},
        );
        return isPublishedListResponse(body) ? body : null;
      } catch {
        return null;
      }
    }, [client]);

  const searchArtifacts = useCallback(
    async (
      kind: ProfileArtifactPathKind,
      query: string,
    ): Promise<SearchPublishableArtifactsResponse | null> => {
      try {
        const body: unknown = await client.read(
          'account.profile.artifacts.search',
          { kind, query },
        );
        return isSearchResponse(body) ? body : null;
      } catch {
        return null;
      }
    },
    [client],
  );

  const previewArtifact = useCallback(
    async (
      kind: ProfileArtifactPathKind,
      sourceId: string,
    ): Promise<PublicProfileArtifactDetail | null> => {
      try {
        return parsePreview(
          await client.read('account.profile.artifacts.preview', {
            kind,
            sourceId,
          }),
        );
      } catch {
        return null;
      }
    },
    [client],
  );

  const publishArtifact = useCallback(
    async (
      kind: ProfileArtifactPathKind,
      sourceId: string,
    ): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await client.write('account.profile.artifacts.publish', {
          kind,
          sourceId,
        });
        return true;
      } catch (err: unknown) {
        setError(
          errorCopy.actionCopy(err, {
            action: 'add this to your profile',
            known: PUBLISH_ARTIFACT_KNOWN_ERRORS,
          }),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [client, errorCopy],
  );

  const unpublishArtifact = useCallback(
    async (
      kind: ProfileArtifactPathKind,
      sourceId: string,
    ): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await client.write('account.profile.artifacts.unpublish', {
          kind,
          sourceId,
        });
        return true;
      } catch (err: unknown) {
        setError(
          errorCopy.actionCopy(err, {
            action: 'remove this from your profile',
          }),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [client, errorCopy],
  );

  const revokeSkillShare = useCallback(
    async (sourceId: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await client.write('account.profile.artifacts.revokeSkillShare', {
          sourceId,
        });
        return true;
      } catch (err: unknown) {
        setError(
          errorCopy.actionCopy(err, { action: 'revoke the share link' }),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [client, errorCopy],
  );

  // Memoize the returned object so its identity is stable across renders.
  // Consumers put this in effect/callback dependency arrays (e.g. the
  // PublishedArtifactsManager refresh effect); a fresh object literal every
  // render would retrigger those effects and loop the artifacts fetch forever.
  return useMemo(
    () => ({
      busy,
      error,
      clearError,
      save,
      checkUsername,
      listArtifacts,
      listPublished,
      searchArtifacts,
      previewArtifact,
      publishArtifact,
      unpublishArtifact,
      revokeSkillShare,
    }),
    [
      busy,
      error,
      clearError,
      save,
      checkUsername,
      listArtifacts,
      listPublished,
      searchArtifacts,
      previewArtifact,
      publishArtifact,
      unpublishArtifact,
      revokeSkillShare,
    ],
  );
}
