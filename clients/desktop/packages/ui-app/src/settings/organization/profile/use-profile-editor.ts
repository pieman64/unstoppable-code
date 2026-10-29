'use client';

import { useCallback, useState } from 'react';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import {
  MAX_AVATAR_UPLOAD_BYTES,
  isAllowedAvatarMimeType,
  type AllowedAvatarMimeType,
  type UpdateProfileResponse,
} from '@canopy/protocol/settings/account';
import { useSettingsClient } from '../../host';
import { useSettingsErrorCopy, type KnownSettingsError } from '../../errors';

const INVALID_FILE_ERROR = 'Choose a PNG, JPEG, or GIF image up to 5 MB.';

/** Failures of the avatar upload that have their own copy. */
const UPLOAD_AVATAR_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  {
    // The moderated commit refused the image.
    status: 422,
    copy: "This image can't be used as a profile photo. Choose a different image.",
  },
];

function isUpdateProfileResponse(
  value: unknown,
): value is UpdateProfileResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'image' in value &&
    (value.image === null || typeof value.image === 'string')
  );
}

/**
 * Which identity the profile editor writes to. `self` edits the signed-in
 * user's real global `User` record (`account.details.update`,
 * `account.avatar.*`); `org-member` edits another member's org-scoped
 * override (`organization.members.profile.*`). The request/response shapes
 * are identical for both; only the operations differ.
 */
export type ProfileEditTarget =
  | { mode: 'self' }
  | { mode: 'org-member'; orgId: string; userId: string };

const SELF_TARGET: ProfileEditTarget = { mode: 'self' };

/** A target flattened to primitives, so callbacks depend on values. */
type ResolvedTarget =
  | { mode: 'self' }
  | { mode: 'org-member'; organizationId: string; userId: string };

function resolveTarget(
  mode: ProfileEditTarget['mode'],
  orgId: string | null,
  userId: string | null,
): ResolvedTarget {
  return mode === 'org-member' && orgId && userId
    ? { mode: 'org-member', organizationId: orgId, userId }
    : { mode: 'self' };
}

/**
 * The avatar upload: sign, PUT the bytes to storage and commit through the
 * moderated route, all inside the host's `upload` transport.
 */
async function uploadAvatarImage(
  client: AccountOrganizationSettingsClient,
  target: ResolvedTarget,
  file: File,
  mimeType: AllowedAvatarMimeType,
): Promise<string> {
  const upload = { mimeType, size: file.size, file };
  const result =
    target.mode === 'org-member'
      ? await client.write('organization.members.profile.avatar.upload', {
          organizationId: target.organizationId,
          userId: target.userId,
          ...upload,
        })
      : await client.write('account.avatar.upload', upload);
  return result.image;
}

/** The PATCH behind a name change or an avatar removal. */
async function patchProfileIdentity(
  client: AccountOrganizationSettingsClient,
  target: ResolvedTarget,
  payload: { name: string } | { image: null },
): Promise<unknown> {
  if (target.mode === 'org-member')
    return client.write('organization.members.profile.update', {
      organizationId: target.organizationId,
      userId: target.userId,
      ...payload,
    });
  return 'name' in payload
    ? client.write('account.details.update', { name: payload.name })
    : client.write('account.avatar.remove', {});
}

/** What a profile PATCH was for, as the failure copy's verb phrase. */
function patchAction(payload: { name: string } | { image: null }): string {
  return 'name' in payload ? 'save the name' : 'remove the photo';
}

export interface UseProfileEditorResult {
  /** True while any upload/commit/name request is in flight. */
  busy: boolean;
  /** Last user-facing error, or `null`. */
  error: string | null;
  /** Clear the current error (e.g. when reopening an editor). */
  clearError: () => void;
  /**
   * Validate, upload, moderate, and publish a new avatar. Resolves to the
   * public image URL on success, or `null` on failure (with `error` set).
   */
  uploadAvatar: (file: File) => Promise<string | null>;
  /** Clear the avatar back to initials. Resolves to `true` on success. */
  removeAvatar: () => Promise<boolean>;
  /**
   * Persist a new display name. Resolves to the saved name on success, or
   * `null` on failure (with `error` set).
   */
  updateName: (name: string) => Promise<string | null>;
}

/**
 * Shared profile-editing transport for the signed-in user's own `name` and
 * `image`. Lives in one place so the member profile header and the Account
 * settings page run the exact same upload → moderate → publish and name-PATCH
 * flows through the settings client.
 */
export function useProfileEditor(
  target: ProfileEditTarget = SELF_TARGET,
): UseProfileEditorResult {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy('settings.profile.identity');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Flatten the target into primitive deps so the callbacks can be
  // statically dependency-checked (a `null` org/user id means the self routes).
  const targetMode = target.mode;
  const targetOrgId = target.mode === 'org-member' ? target.orgId : null;
  const targetUserId = target.mode === 'org-member' ? target.userId : null;

  const clearError = useCallback((): void => {
    setError(null);
  }, []);

  const uploadAvatar = useCallback(
    async (file: File): Promise<string | null> => {
      if (busy) {
        return null;
      }
      const mimeType = file.type;
      if (!isAllowedAvatarMimeType(mimeType) || file.size <= 0) {
        setError(INVALID_FILE_ERROR);
        return null;
      }
      if (file.size > MAX_AVATAR_UPLOAD_BYTES) {
        setError(INVALID_FILE_ERROR);
        return null;
      }

      setBusy(true);
      setError(null);
      try {
        return await uploadAvatarImage(
          client,
          resolveTarget(targetMode, targetOrgId, targetUserId),
          file,
          mimeType,
        );
      } catch (err: unknown) {
        setError(
          errorCopy.actionCopy(err, {
            action: 'upload the photo',
            known: UPLOAD_AVATAR_KNOWN_ERRORS,
          }),
        );
        return null;
      } finally {
        setBusy(false);
      }
    },
    [busy, client, errorCopy, targetMode, targetOrgId, targetUserId],
  );

  const patchProfile = useCallback(
    async (
      payload: { name: string } | { image: null },
    ): Promise<UpdateProfileResponse | null> => {
      setBusy(true);
      setError(null);
      try {
        const body = await patchProfileIdentity(
          client,
          resolveTarget(targetMode, targetOrgId, targetUserId),
          payload,
        );
        if (!isUpdateProfileResponse(body)) {
          setError(
            errorCopy.actionCopy(new Error('Invalid profile response'), {
              action: patchAction(payload),
            }),
          );
          return null;
        }
        return body;
      } catch (err: unknown) {
        setError(errorCopy.actionCopy(err, { action: patchAction(payload) }));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [client, errorCopy, targetMode, targetOrgId, targetUserId],
  );

  const updateName = useCallback(
    async (name: string): Promise<string | null> => {
      if (busy) {
        return null;
      }
      const result = await patchProfile({ name });
      return result?.name ?? null;
    },
    [busy, patchProfile],
  );

  const removeAvatar = useCallback(async (): Promise<boolean> => {
    if (busy) {
      return false;
    }
    const result = await patchProfile({ image: null });
    return result !== null;
  }, [busy, patchProfile]);

  return {
    busy,
    error,
    clearError,
    uploadAvatar,
    removeAvatar,
    updateName,
  };
}
