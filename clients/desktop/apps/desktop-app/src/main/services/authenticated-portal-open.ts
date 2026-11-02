import {
  authenticatedPortalRequestSchema,
  authenticatedPortalResultSchema,
  classifyAuthenticatedPortalPath,
  normalizeAuthenticatedPortalOrigin,
  type AuthenticatedPortalResult,
} from '@canopy/desktop-shared/lib/authenticated-portal-request';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import {
  getCanopyCloudCredentials,
  loadCanopyCloudAccount,
} from '../lib/canopy-cloud-account-store';
import {
  openAuthenticatedPortalPage,
  openStrictAuthenticatedPortalPage,
} from '../canopy-cloud/authenticated-portal';

/** Main owns credentials; renderer identity and origin are assertions only. */
export async function openAuthenticatedPortalRequest(
  value: unknown,
): Promise<AuthenticatedPortalResult> {
  const request = authenticatedPortalRequestSchema.safeParse(value);
  if (!request.success) return { ok: false, reason: 'failed' };
  try {
    const snapshot = await loadCanopyCloudAccount();
    if (
      !snapshot?.account?.id ||
      isGuestAccount(snapshot) ||
      !snapshot.apiKey.trim()
    )
      return { ok: false, reason: 'unavailable' };
    const credentials = await getCanopyCloudCredentials().catch(() => null);
    if (!credentials?.account?.id || !credentials.apiKey.trim())
      return { ok: false, reason: 'unavailable' };
    const origin = normalizeAuthenticatedPortalOrigin(credentials.baseUrl);
    if (
      credentials.account.id !== snapshot.account.id ||
      credentials.apiKey !== snapshot.apiKey ||
      request.data.accountId !== snapshot.account.id ||
      origin === null ||
      origin !== normalizeAuthenticatedPortalOrigin(request.data.webOrigin)
    )
      return { ok: false, reason: 'identity_changed' };
    if (
      classifyAuthenticatedPortalPath(request.data.path) !== request.data.kind
    )
      return { ok: false, reason: 'failed' };
    const result = authenticatedPortalResultSchema.safeParse(
      request.data.kind === 'payment'
        ? await openStrictAuthenticatedPortalPage(
            request.data.path,
            credentials,
          )
        : await openAuthenticatedPortalPage(request.data.path, {
            requireAuthentication: true,
            credentialContext: credentials,
          }),
    );
    return result.success ? result.data : { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}
