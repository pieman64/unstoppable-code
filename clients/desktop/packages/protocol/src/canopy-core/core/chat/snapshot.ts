import { z } from 'zod';

import {
  CanopyWorkspaceScopeSchema,
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyJsonValueSchema,
} from '../shared';

const id = z.string().min(1).max(512);
const revision = z.number().int().nonnegative();
const scopedWorktree = CanopyWorkspaceScopeSchema.extend({
  workspaceId: id,
  worktreeId: id,
});

export const CoreChatSnapshotGetParamsSchema = z.strictObject({
  scope: scopedWorktree,
  chatId: id.optional(),
});

export const CoreChatTabSummarySchema = z.object({
  chatId: id,
  title: z.string(),
  kind: z.enum(['chat', 'file']),
  createdAt: z.string(),
  unread: z.boolean().optional(),
  providerId: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
});

export const CoreChatArchiveSummarySchema = z.object({
  chatId: id,
  title: z.string(),
  archivedAt: z.string(),
  createdAt: z.string(),
  turnCount: z.number().int().nonnegative(),
  unread: z.boolean(),
  restorable: z.boolean(),
});

export const CoreChatRuntimeSummarySchema = z.object({
  status: z.enum([
    'idle',
    'queued',
    'starting',
    'streaming',
    'awaiting_input',
    'completing',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
  ]),
  queuedMessageIds: z.array(id),
  lastActivityAt: z.number().optional(),
});

export const CoreChatQueueSummarySchema = z.object({
  chatId: id,
  entries: z.array(
    z.object({
      id,
      origin: z.enum(['desktop', 'portal']),
      enqueuedAtMs: z.number(),
    }),
  ),
});

export const CoreChatSnapshotGetResultSchema = z.object({
  workspaceId: id,
  worktreeId: id,
  revision,
  tabs: z.object({
    activeTabId: z.string(),
    items: z.array(CoreChatTabSummarySchema),
  }),
  archives: z.array(CoreChatArchiveSummarySchema),
  runtimeByChatId: z.record(id, CoreChatRuntimeSummarySchema),
  queue: z.array(CoreChatQueueSummarySchema),
  pendingApprovals: z.array(CanopyJsonValueSchema).optional(),
  todos: z.array(CanopyJsonValueSchema).optional(),
});

export const CoreChatSnapshotGetErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.chat.snapshot.invalidState',
      'core.chat.snapshot.revisionConflict',
      'core.chat.snapshot.notFound',
    ])
    .optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const CoreChatListParamsSchema = z.strictObject({
  scope: scopedWorktree,
  pageSize: z.number().int().min(1).max(500).default(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});

export const CoreChatListResultSchema = z.object({
  items: z.array(
    z.object({
      chatId: id,
      workspaceId: id,
      worktreeId: id.nullable(),
      title: z.string(),
      state: z.enum([
        'idle',
        'queued',
        'running',
        'awaiting_user',
        'completed',
        'failed',
        'archived',
      ]),
      revision,
      providerId: z.string().nullable().optional(),
      modelId: z.string().nullable().optional(),
      providerSessionId: z.string().nullable().optional(),
      targetId: z.string().nullable().optional(),
      createdAt: z.string(),
      updatedAt: z.iso.datetime({ offset: true }).optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const CoreChatListErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.chat.invalidState',
      'core.chat.revisionConflict',
      'core.chat.notFound',
    ])
    .optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});
