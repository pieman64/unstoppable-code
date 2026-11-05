import { marketplaceShareOrigin } from '@canopy/protocol/marketplace';
import type { PortalCommandEnvelope } from '@canopy/desktop-shared/types';
import type { PortalShareResult } from '@canopy/protocol/portal';
import { getCanopyCloudBaseUrl } from '../../canopy-cloud/config';
import {
  ShareStageError,
  runClassifiedShare,
} from '../../sharing/share-operation-result';
import type { PortalAdapterContext } from './types';
import { failServiceError } from './validation';

/**
 * Add the absolute share URL, resolved against the publishing account's cloud
 * origin rather than whichever origin the browser happens to be on.
 */
export function withPortalShareUrl<T extends { sharePath?: string }>(
  result: T,
): T & { shareUrl?: string } {
  if (result.sharePath === undefined || result.sharePath.length === 0) {
    return result;
  }
  try {
    const origin = marketplaceShareOrigin(getCanopyCloudBaseUrl());
    if (
      !origin ||
      !result.sharePath.startsWith('/') ||
      result.sharePath.startsWith('//') ||
      /[\\\s]/.test(result.sharePath)
    )
      return result;
    return {
      ...result,
      shareUrl: new URL(result.sharePath, origin).toString(),
    };
  } catch {
    // Missing or malformed publishing configuration cannot turn a successful
    // mutation into failure. New browsers wait for an authoritative absolute link.
    return result;
  }
}

/**
 * Complete a Portal share command off the serial command loop.
 *
 * Portal failure events carry only a code and message, so a classified share
 * failure completes with a `PortalShareResult` carrying `failure` instead; the
 * browser treats a result with a valid `failure` as a failed share. Definite
 * failures that classify as `unknown` keep the legacy failure event and
 * message.
 */
export function completePortalShareOffLoop<
  TResult extends { sharePath?: string },
>(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
  operation: () => Promise<TResult>,
): void {
  void (async (): Promise<void> => {
    const outcome = await runClassifiedShare(operation);
    if (outcome.ok) {
      context.complete(command, withPortalShareUrl(outcome.value));
      return;
    }
    const { error, failure } = outcome;
    if (failure.kind === 'unknown' && failure.commitState === 'not-committed') {
      // The legacy event reads the original error's code and message. An
      // uncertain or landed share completes with its failure instead,
      // because the browser reads a legacy failure event as a definite
      // rejection and would offer to share again.
      failServiceError(
        command,
        context,
        error instanceof ShareStageError ? error.failureCause : error,
      );
      return;
    }
    const failed: PortalShareResult = { message: failure.message, failure };
    context.complete(command, failed);
  })();
}
