import {
  IPC_CHANNELS,
  type FeedbackPrepareRequest,
  type FeedbackPrepareResponse,
  type FeedbackSubmitRequest,
  type FeedbackSubmitResponse,
} from '@canopy/desktop-shared/types';
import { prepareFeedbackBundle } from '../feedback/feedback-bundle';
import { submitFeedback } from '../feedback/feedback-submit';
import { registerIpcHandler } from './register';

export function registerFeedbackHandlers(): void {
  registerIpcHandler<[FeedbackPrepareRequest], FeedbackPrepareResponse>(
    IPC_CHANNELS.feedbackPrepare,
    async (_event, request) => prepareFeedbackBundle(request),
  );
  registerIpcHandler<[FeedbackSubmitRequest], FeedbackSubmitResponse>(
    IPC_CHANNELS.feedbackSubmit,
    async (_event, request) => submitFeedback(request),
  );
}
