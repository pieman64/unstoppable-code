import {
  IPC_CHANNELS,
  type TurnFeedbackClearRequest,
  type TurnFeedbackClearResponse,
  type TurnFeedbackDetailRequestIpc,
  type TurnFeedbackDetailResponse,
  type TurnFeedbackListRequest,
  type TurnFeedbackListResponseIpc,
  type TurnFeedbackRateRequestIpc,
  type TurnFeedbackRateResponse,
} from '@canopy/desktop-shared/types';
import { isTurnFeedbackRating } from '@canopy/protocol/turn-feedback';
import {
  clearTurnFeedback,
  listTurnFeedback,
  rateTurnFeedback,
  submitTurnFeedbackDetail,
} from '../feedback/turn-feedback-client';
import { registerIpcHandler } from './register';

/**
 * Turn-level thumbs up/down IPC (CAN-1521).
 *
 * Every handler **resolves and never rejects**, following the
 * `orgMemoryFeedbackSubmit` precedent. A rating is a lightweight, low-stakes
 * gesture; a rejected `invoke()` would surface as an unhandled renderer error
 * for something the user should never have to think about. Unreachable-server
 * cases come back as `{ recorded: false, queued: true }` instead.
 *
 * Note the ids here are deliberately NOT run through `validateId`: the
 * renderer's `msg-{n}-{epochMs}` and chat ids do not all match the
 * `/^[a-z0-9][a-z0-9-]*$/` contract, and rejecting on shape would silently
 * disable feedback for whole surfaces. The server re-validates and bounds them.
 */
export function registerTurnFeedbackHandlers(): void {
  registerIpcHandler<[TurnFeedbackRateRequestIpc], TurnFeedbackRateResponse>(
    IPC_CHANNELS.turnFeedbackRate,
    async (_event, request) => {
      if (
        typeof request?.clientUserMessageId !== 'string' ||
        request.clientUserMessageId.length === 0 ||
        typeof request.clientChatId !== 'string' ||
        request.clientChatId.length === 0 ||
        !isTurnFeedbackRating(request.rating)
      ) {
        return { recorded: false, queued: false };
      }
      return rateTurnFeedback(request);
    },
  );

  registerIpcHandler<
    [TurnFeedbackDetailRequestIpc],
    TurnFeedbackDetailResponse
  >(IPC_CHANNELS.turnFeedbackDetail, async (_event, request) => {
    if (
      typeof request?.clientUserMessageId !== 'string' ||
      request.clientUserMessageId.length === 0 ||
      (request.reason === undefined && request.comment === undefined)
    ) {
      return { recorded: false, queued: false };
    }
    return submitTurnFeedbackDetail(request);
  });

  registerIpcHandler<[TurnFeedbackClearRequest], TurnFeedbackClearResponse>(
    IPC_CHANNELS.turnFeedbackClear,
    async (_event, request) => {
      if (
        typeof request?.clientUserMessageId !== 'string' ||
        request.clientUserMessageId.length === 0
      ) {
        return { cleared: false };
      }
      return clearTurnFeedback(request);
    },
  );

  registerIpcHandler<[TurnFeedbackListRequest], TurnFeedbackListResponseIpc>(
    IPC_CHANNELS.turnFeedbackList,
    async (_event, request) => {
      if (
        typeof request?.clientChatId !== 'string' ||
        request.clientChatId.length === 0
      ) {
        return { feedback: [] };
      }
      return listTurnFeedback(request);
    },
  );
}
