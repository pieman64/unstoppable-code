'use client';

import { useCallback, useState } from 'react';
import {
  ORGANIZATION_LOGO_MAX_BYTES,
  isOrganizationLogoContentType,
  type OrganizationDetail,
} from '@canopy/protocol/settings/organization';
import { useSettingsClient } from '../host';
import { useSettingsErrorCopy, type KnownSettingsError } from '../errors';
import { clearOrgLogo, uploadOrgLogo } from './team-api';

const INVALID_FILE_ERROR = 'Choose a PNG, JPEG, or GIF image up to 5 MB.';

/** Failures of the logo commit that have their own copy. */
const UPLOAD_LOGO_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  {
    // The moderated commit refused the image.
    status: 422,
    copy: "This image can't be used as a logo. Choose a different image.",
  },
];

export interface UseOrgLogoEditorResult {
  /** True while any upload/commit/remove request is in flight. */
  busy: boolean;
  /** Last user-facing error, or `null`. */
  error: string | null;
  /** Clear the current error (e.g. when reopening an editor). */
  clearError: () => void;
  /**
   * Validate, upload, moderate, and publish a new org logo. Resolves to the
   * refreshed {@link OrganizationDetail} on success, or `null` on failure (with
   * `error` set).
   */
  uploadLogo: (file: File) => Promise<OrganizationDetail | null>;
  /**
   * Clear the org logo back to the initials placeholder. Resolves to the
   * refreshed {@link OrganizationDetail} on success, or `null` on failure.
   */
  removeLogo: () => Promise<OrganizationDetail | null>;
}

/**
 * Shared org-logo editing transport for a single organization. Mirrors
 * {@link useProfileEditor}: runs the upload-url → direct GCS PUT → moderated
 * commit flow (and the PATCH-clear for removal) so the org-page header and the
 * branding settings card drive the exact same moderated-upload pipeline.
 */
export function useOrgLogoEditor(orgId: string): UseOrgLogoEditorResult {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy('settings.organization.logo');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback((): void => {
    setError(null);
  }, []);

  const uploadLogo = useCallback(
    async (file: File): Promise<OrganizationDetail | null> => {
      if (busy) {
        return null;
      }
      const mimeType = file.type;
      if (
        !isOrganizationLogoContentType(mimeType) ||
        file.size <= 0 ||
        file.size > ORGANIZATION_LOGO_MAX_BYTES
      ) {
        setError(INVALID_FILE_ERROR);
        return null;
      }

      setBusy(true);
      setError(null);
      try {
        // The host signs the upload, PUTs the bytes to storage without
        // credentials, then runs the moderated commit.
        return await uploadOrgLogo(client, orgId, file, mimeType);
      } catch (err) {
        setError(
          errorCopy.actionCopy(err, {
            action: 'upload the logo',
            known: UPLOAD_LOGO_KNOWN_ERRORS,
          }),
        );
        return null;
      } finally {
        setBusy(false);
      }
    },
    [busy, client, errorCopy, orgId],
  );

  const removeLogo =
    useCallback(async (): Promise<OrganizationDetail | null> => {
      if (busy) {
        return null;
      }
      setBusy(true);
      setError(null);
      try {
        return await clearOrgLogo(client, orgId);
      } catch (err) {
        setError(errorCopy.actionCopy(err, { action: 'remove the logo' }));
        return null;
      } finally {
        setBusy(false);
      }
    }, [busy, client, errorCopy, orgId]);

  return { busy, error, clearError, uploadLogo, removeLogo };
}
