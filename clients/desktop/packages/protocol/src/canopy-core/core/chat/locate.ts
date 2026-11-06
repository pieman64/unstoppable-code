import { z } from 'zod';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyWorkspaceScopeSchema,
} from '../shared';

const id = z.string().min(1).max(512);

export const CoreChatLocateParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.extend({ workspaceId: id }),
  chatId: id,
});
export type CoreChatLocateParams = z.output<typeof CoreChatLocateParamsSchema>;

export const CoreChatLocateResultSchema = z.strictObject({
  /** The chat scope's worktree (a Cowork or App Advisor Work Entry) whose live tabs hold the chat. */
  worktreeId: id.nullable(),
  /** The chat scope whose archive holds the chat. */
  archivedInWorktreeId: id.nullable(),
});
export type CoreChatLocateResult = z.output<typeof CoreChatLocateResultSchema>;

export const CoreChatLocateErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(['core.chat.locate.unavailable']).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});
