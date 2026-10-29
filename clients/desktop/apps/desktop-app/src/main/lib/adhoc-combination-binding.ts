import type {
  AdhocMultiRepoMode,
  AdhocMultiRepoCombineResponse,
} from '@canopy/desktop-shared/types';
import {
  convertOrgProjectCombinationNow,
  reportOrgProjectAutoConversionFailure,
} from '../services/org-project-auto-conversion-host';
import { listWorkspaceItems } from './workspace-service';

function reportFailure(error: unknown): void {
  try {
    reportOrgProjectAutoConversionFailure(error);
  } catch {
    // Even a failing host reporter cannot affect a committed join or refresh.
  }
}

/** Bind eligible combinations before replying; ownership always comes from disk. */
export async function bindCombinationAfterJoin<
  T extends AdhocMultiRepoCombineResponse,
>(response: T, mode: AdhocMultiRepoMode): Promise<T> {
  if (
    mode !== 'temporary' ||
    response.destinationWorkspace.temporary !== true ||
    response.destinationWorkspace.owner !== undefined
  )
    return response;

  try {
    await convertOrgProjectCombinationNow(response.destinationWorkspaceId);
  } catch (error) {
    reportFailure(error);
  }

  // A refusal/null/error can still race a successful manual or queued binding.
  // Refresh independently of conversion, and never synthesize an event's owner.
  try {
    const destination = (
      await listWorkspaceItems({ includeEmptyTemporary: true })
    ).find((item): boolean => item.id === response.destinationWorkspaceId);
    if (!destination || destination.type !== 'multi-repo') {
      reportFailure(
        new Error('Combined destination is missing or is not multi-repo'),
      );
      return response;
    }
    return { ...response, destinationWorkspace: destination };
  } catch (error) {
    reportFailure(error);
    return response;
  }
}
