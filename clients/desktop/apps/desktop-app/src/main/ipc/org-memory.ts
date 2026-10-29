import {
  IPC_CHANNELS,
  type OrgMemoryFeedbackRequest,
  type OrgMemoryFeedbackResponse,
  type OrgMemoryFeedbackQuery,
  type OrgMemoryFeedbackQueryResponse,
} from '@canopy/desktop-shared/types';
import { normalizeOrganizationExternalId } from '@canopy/desktop-shared/lib/org-memory';
import {
  getOrgMemoryFeedback,
  submitOrgMemoryFeedback,
} from '../memory/memory-client';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';

export function registerOrgMemoryHandlers(): void {
  registerIpcHandler<[OrgMemoryFeedbackRequest], OrgMemoryFeedbackResponse>(
    IPC_CHANNELS.orgMemoryFeedbackSubmit,
    async (_event, request) => {
      const rating =
        request.rating === 'like' || request.rating === 'dislike'
          ? request.rating
          : undefined;
      const comment =
        typeof request.comment === 'string' && request.comment.trim().length > 0
          ? request.comment.trim()
          : undefined;
      const organizationExternalId = normalizeOrganizationExternalId(
        request.organizationExternalId,
      );
      if (
        organizationExternalId === null ||
        typeof request.searchId !== 'string' ||
        typeof request.factId !== 'string' ||
        (rating === undefined && comment === undefined)
      ) {
        // Occurrences persisted before the searched org was recorded carry no
        // org and stay read-only: feedback never guesses an org (CAN-3457).
        return { recorded: false };
      }
      // Server fact ids are lowercase UUIDs, which conform to the standard
      // IPC id contract enforced here.
      validateId(request.searchId, 'searchId');
      validateId(request.factId, 'factId');
      return submitOrgMemoryFeedback({
        organizationExternalId,
        searchId: request.searchId,
        factId: request.factId,
        ...(rating === undefined ? {} : { rating }),
        ...(comment === undefined ? {} : { comment }),
      });
    },
  );
  registerIpcHandler<[OrgMemoryFeedbackQuery], OrgMemoryFeedbackQueryResponse>(
    IPC_CHANNELS.orgMemoryFeedbackGet,
    async (_event, request) => {
      const organizationExternalId = normalizeOrganizationExternalId(
        request?.organizationExternalId,
      );
      if (
        organizationExternalId === null ||
        typeof request?.searchId !== 'string' ||
        typeof request?.factId !== 'string'
      ) {
        return { feedback: null, canSubmit: false };
      }
      validateId(request.searchId, 'searchId');
      validateId(request.factId, 'factId');
      return getOrgMemoryFeedback({
        organizationExternalId,
        searchId: request.searchId,
        factId: request.factId,
      });
    },
  );
}
