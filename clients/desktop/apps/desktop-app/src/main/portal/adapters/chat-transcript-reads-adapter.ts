import { CanopyOperationError } from '@canopy/core-runtime';
import type { PortalCommandEnvelope } from '@canopy/desktop-shared/types';
import {
  CoreChatContentReadParamsSchema,
  CoreChatTranscriptPageParamsSchema,
  CoreChatTranscriptBlocksPageParamsSchema,
  type CoreChatTranscriptPageParams,
} from '@canopy/protocol/canopy-core';
import {
  PortalChatContentReadV2PayloadSchema,
  PortalChatTranscriptBlocksPagePayloadSchema,
  type PortalChatContentReadPayload,
  type PortalChatTranscriptBlocksPagePayload,
  type PortalChatTranscriptPagePayload,
  PortalChatTranscriptPagePayloadSchema,
  transcriptReadFailure,
  type PortalTranscriptReadReply,
  type PortalTranscriptSource,
} from '@canopy/protocol/portal';
import { resolveStandaloneChatTarget } from '../../services/standalone-chat-service';
import {
  queryPortalDelegationTranscriptPage,
  queryPortalTranscriptBlocksPage,
  queryPortalTranscriptContent,
} from './chat-state-query';
import type { PortalAdapterContext } from './types';

export const PORTAL_TRANSCRIPT_READ_EXECUTION_MS = 120_000;

// Only failures created by our validation may become portal.command.failed.
// Service exceptions, even typed ones, must never forward backend messages.
class TranscriptValidationError extends Error {
  public constructor(
    public readonly code: 'invalid_payload' | 'invalid_target',
    message: string,
  ) {
    super(message);
  }
}

type ReadSource = Pick<
  CoreChatTranscriptPageParams,
  'scope' | 'archivedContainerId'
>;

function matchesSource(
  command: PortalCommandEnvelope<unknown>,
  source: PortalTranscriptSource,
): boolean {
  const envelope = command.target;
  return source.kind === 'worktree'
    ? envelope?.workspaceLocalId === source.workspaceId &&
        envelope.worktreeLocalId === source.worktreeId &&
        envelope.standaloneChatLocalId === undefined
    : envelope?.standaloneChatLocalId === source.chatId &&
        envelope.workspaceLocalId === undefined &&
        envelope.worktreeLocalId === undefined;
}

async function resolveSource(
  source: PortalTranscriptSource,
): Promise<ReadSource | null> {
  if (source.kind === 'worktree') {
    return {
      scope: {
        workspaceId: source.workspaceId,
        worktreeId: source.worktreeId,
        chatId: source.chatId,
      },
      ...(source.archivedContainerId === undefined
        ? {}
        : { archivedContainerId: source.archivedContainerId }),
    };
  }
  const resolved = await resolveStandaloneChatTarget({
    projectLocalId: source.projectLocalId,
    chatId: source.chatId,
  });
  const worktreeId = resolved.archivedInEntryId ?? resolved.entryId;
  // S6/A5: pre-entry standalone archives are unavailable for both child and primary reads.
  if (!worktreeId) return null;
  return {
    scope: {
      workspaceId: resolved.workspaceId,
      worktreeId,
      chatId: source.chatId,
    },
    ...(resolved.archivedInEntryId
      ? { archivedContainerId: resolved.archivedInEntryId }
      : {}),
  };
}

function invalidPayload(): TranscriptValidationError {
  return new TranscriptValidationError(
    'invalid_payload',
    'Invalid transcript read payload.',
  );
}

type ParsedRead =
  | {
      type: 'portal.chat.transcript.page';
      payload: PortalChatTranscriptPagePayload;
    }
  | {
      type: 'portal.chat.transcript.blocks.page';
      payload: PortalChatTranscriptBlocksPagePayload;
    }
  | { type: 'portal.chat.content.read'; payload: PortalChatContentReadPayload };

function parseRead(command: PortalCommandEnvelope<unknown>): ParsedRead | null {
  switch (command.type) {
    case 'portal.chat.transcript.page': {
      const parsed = PortalChatTranscriptPagePayloadSchema.safeParse(
        command.payload,
      );
      return parsed.success
        ? { type: command.type, payload: parsed.data }
        : null;
    }
    case 'portal.chat.transcript.blocks.page': {
      const parsed = PortalChatTranscriptBlocksPagePayloadSchema.safeParse(
        command.payload,
      );
      return parsed.success
        ? { type: command.type, payload: parsed.data }
        : null;
    }
    case 'portal.chat.content.read': {
      const parsed = PortalChatContentReadV2PayloadSchema.safeParse(
        command.payload,
      );
      return parsed.success
        ? { type: command.type, payload: parsed.data }
        : null;
    }
    default:
      return null;
  }
}

async function read(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
  signal: AbortSignal,
): Promise<PortalTranscriptReadReply> {
  const parsed = parseRead(command);
  if (!parsed) {
    const payload = command.payload;
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'target' in payload &&
      typeof payload.target === 'object' &&
      payload.target !== null &&
      'kind' in payload.target &&
      payload.target.kind === 'primary'
    ) {
      throw new TranscriptValidationError(
        'invalid_payload',
        'Only delegation transcript reads are supported.',
      );
    }
    throw invalidPayload();
  }
  const payload = parsed.payload;
  if (!matchesSource(command, payload.source))
    throw new TranscriptValidationError(
      'invalid_target',
      'Invalid transcript read target.',
    );
  const source = await resolveSource(payload.source);
  if (signal.aborted || context.canReadTranscripts?.() !== true)
    return { ok: false, reason: 'failed' };
  if (!source) return { ok: false, reason: 'unavailable' };
  switch (parsed.type) {
    case 'portal.chat.content.read': {
      const request = parsed.payload;
      const params = CoreChatContentReadParamsSchema.safeParse({
        ...source,
        target: request.target,
        messageId: request.messageId,
        blockOrdinal: request.blockOrdinal,
        field: request.field,
        ...(request.fieldSource === undefined
          ? {}
          : { fieldSource: request.fieldSource }),
        offset: request.offset,
        limit: request.limit,
      });
      if (!params.success) throw invalidPayload();
      return {
        ok: true,
        value: await queryPortalTranscriptContent(context, params.data, signal),
      };
    }
    case 'portal.chat.transcript.blocks.page': {
      const request = parsed.payload;
      const params = CoreChatTranscriptBlocksPageParamsSchema.safeParse({
        ...source,
        target: request.target,
        messageId: request.messageId,
        ...(request.firstBlockOrdinal === undefined
          ? {}
          : { firstBlockOrdinal: request.firstBlockOrdinal }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        limit: request.limit,
        projection: 'bounded-v1',
      });
      if (!params.success) throw invalidPayload();
      return {
        ok: true,
        value: await queryPortalTranscriptBlocksPage(
          context,
          params.data,
          signal,
        ),
      };
    }
    case 'portal.chat.transcript.page': {
      const request = parsed.payload;
      const params = CoreChatTranscriptPageParamsSchema.safeParse({
        ...source,
        target: request.target,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      });
      if (!params.success) throw invalidPayload();
      return {
        ok: true,
        value: await queryPortalDelegationTranscriptPage(
          context,
          params.data,
          signal,
        ),
      };
    }
  }
}

async function handleRead(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const sessionId = context.sessionId;
  const authorized = (): boolean =>
    Boolean(sessionId) &&
    context.sessionId === sessionId &&
    context.canReadTranscripts?.() === true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    if (!authorized()) {
      context.fail(
        command,
        'invalid_target',
        'The paired transcript session is no longer authorized.',
      );
      return;
    }
    const deadline = new Promise<PortalTranscriptReadReply>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, reason: 'failed' });
      }, PORTAL_TRANSCRIPT_READ_EXECUTION_MS);
    });
    const result = await Promise.race([
      read(command, context, controller.signal),
      deadline,
    ]);
    if (authorized()) context.complete(command, result);
  } catch (error) {
    if (!authorized()) return;
    if (error instanceof TranscriptValidationError) {
      context.fail(command, error.code, error.message);
    } else {
      context.complete(command, {
        ok: false,
        reason: transcriptReadFailure(
          error instanceof CanopyOperationError ? error.payload : error,
        ),
      });
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function handlePortalChatTranscriptPage(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  return handleRead(command, context);
}

export function handlePortalChatContentRead(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  return handleRead(command, context);
}

export function handlePortalChatTranscriptBlocksPage(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  return handleRead(command, context);
}
