import type { PortalCommandEnvelope } from '@canopy/desktop-shared/types';
import {
  isPortalProviderUsageRefreshProvider,
  type PortalProviderUsageRefreshProvider,
  type PortalProviderUsageRefreshResult,
} from '@canopy/protocol/portal';
import { logMainProcessError } from '../../lib/main-process-logging';
import { getObservabilityService } from '../../observability';
import {
  isPortalProviderUsageServedByAccountProxy,
  readPortalProviderUsageAccountProxySource,
} from '../provider-usage-projection';
import type { PortalAdapterContext } from './types';
import { isRecord } from './validation';

/**
 * Refresh the usage the provider's entry shows: the proxy's accounts while
 * the proxy serves the provider, otherwise the native sign-in.
 */
async function refreshProviderUsage(
  provider: PortalProviderUsageRefreshProvider,
): Promise<void> {
  const observability = getObservabilityService();
  if (
    (provider === 'claude' || provider === 'codex') &&
    isPortalProviderUsageServedByAccountProxy(
      provider,
      await readPortalProviderUsageAccountProxySource(),
    )
  ) {
    await observability.refreshAccountProxyUsage({
      interactive: true,
      provider,
    });
    return;
  }
  await observability.refreshProviderUsage(provider, { joinInFlight: true });
}

/**
 * `portal.provider_usage.refresh`: start (or join) the desktop's usage read
 * for one provider and acknowledge right away. The new values reach clients
 * through the `provider_usage` delta, not this command's result.
 */
export const handlePortalProviderUsageRefresh = (
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): void => {
  const payload = command.payload;
  if (
    !isRecord(payload) ||
    !isPortalProviderUsageRefreshProvider(payload.provider)
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid provider usage refresh payload.',
    );
    return;
  }
  const provider = payload.provider;
  refreshProviderUsage(provider).catch((error: unknown): void => {
    logMainProcessError('Portal provider usage refresh failed', error);
  });
  const result: PortalProviderUsageRefreshResult = { provider, accepted: true };
  context.complete(command, result);
};
