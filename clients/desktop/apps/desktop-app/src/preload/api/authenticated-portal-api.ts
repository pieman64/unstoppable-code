import { IPC_CHANNELS, type CanopyApi } from '@canopy/desktop-shared/types';
import {
  authenticatedPortalRequestSchema,
  authenticatedPortalResultSchema,
  type AuthenticatedPortalRequest,
  type AuthenticatedPortalResult,
} from '@canopy/desktop-shared/lib/authenticated-portal-request';

export interface AuthenticatedPortalIpc {
  invoke(
    channel: typeof IPC_CHANNELS.settingsOpenAuthenticatedPortalPage,
    path: string,
  ): Promise<boolean>;
  invoke(
    channel: typeof IPC_CHANNELS.settingsOpenAuthenticatedPortalPage,
    request: AuthenticatedPortalRequest,
  ): Promise<unknown>;
}

/** Strict objects never retry through the legacy string overload. */
export function createAuthenticatedPortalApi(
  ipc: AuthenticatedPortalIpc,
): Pick<CanopyApi, 'openAuthenticatedPortalPage'> {
  function openAuthenticatedPortalPage(path: string): Promise<boolean>;
  function openAuthenticatedPortalPage(
    request: AuthenticatedPortalRequest,
  ): Promise<AuthenticatedPortalResult>;
  async function openAuthenticatedPortalPage(
    value: string | AuthenticatedPortalRequest,
  ): Promise<boolean | AuthenticatedPortalResult> {
    if (typeof value === 'string')
      return ipc.invoke(
        IPC_CHANNELS.settingsOpenAuthenticatedPortalPage,
        value,
      );
    const request = authenticatedPortalRequestSchema.safeParse(value);
    if (!request.success) return { ok: false, reason: 'failed' };
    try {
      const result = authenticatedPortalResultSchema.safeParse(
        await ipc.invoke(
          IPC_CHANNELS.settingsOpenAuthenticatedPortalPage,
          request.data,
        ),
      );
      return result.success ? result.data : { ok: false, reason: 'failed' };
    } catch {
      return { ok: false, reason: 'failed' };
    }
  }
  return { openAuthenticatedPortalPage };
}
