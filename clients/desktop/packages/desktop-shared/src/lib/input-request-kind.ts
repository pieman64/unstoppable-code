import type { ChatSendMessageRequest } from '../types';
import { isInternalChatRequest } from './internal-chat-row';

type InputRequestClassification =
  | 'watcher'
  | 'answer'
  | 'automation'
  | 'delegation'
  | 'ordinary';

export function classifyInputRequest(
  request: ChatSendMessageRequest,
): InputRequestClassification {
  if (isInternalChatRequest(request)) return 'delegation';
  if (request.watcherFired !== undefined) return 'watcher';
  if (request.asyncQuestionId !== undefined) return 'answer';
  if (
    request.initiationSource === 'automation' &&
    request.automationName?.trim()
  )
    return 'automation';
  return 'ordinary';
}

/** Watcher, async-answer, automation and delegation input: not typed by the user. */
export function isGeneratedInputRequest(
  request: ChatSendMessageRequest,
): boolean {
  return classifyInputRequest(request) !== 'ordinary';
}
