import { join, isAbsolute } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type PortalCommandEnvelope,
  type PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import {
  isVisiblePersistedChatMessage,
  portalChatAttachmentPaths,
} from '@canopy/agent-transcript';
import {
  portalChatAssetId,
  type PortalAssetReadRange,
} from '@canopy/protocol/portal';
import { getCodexRuntimeService } from '../../codex/runtime-service';
import { validateId } from '../../lib/validation';
import { resolveStandaloneChatTarget } from '../../services/standalone-chat-service';
import {
  resolvePortalChatAssetFileTarget,
  resolvePortalFileTarget,
} from '../../services/files-service';
import {
  readPortalAssetDataUrl,
  readPortalAssetFile,
} from '../../services/portal-asset-service';
import { PortalServiceError } from '../../services/portal-service-error';
import { failServiceError, isRecord } from './validation';
import type { PortalAdapterContext } from './types';
import {
  queryPortalChatState,
  queryPortalChatTranscriptPage,
} from './chat-state-query';

function rangeFrom(payload: Record<string, unknown>): PortalAssetReadRange {
  if (
    (payload.offset !== undefined && typeof payload.offset !== 'number') ||
    (typeof payload.offset === 'number' &&
      (!Number.isSafeInteger(payload.offset) || payload.offset < 0)) ||
    (payload.version !== undefined && typeof payload.version !== 'string')
  ) {
    throw new PortalServiceError(
      'invalid_payload',
      'Invalid asset read range.',
    );
  }
  return {
    ...(typeof payload.offset === 'number' ? { offset: payload.offset } : {}),
    ...(typeof payload.version === 'string'
      ? { version: payload.version }
      : {}),
  };
}

function requireAssetPermission(context: PortalAdapterContext): void {
  if (context.canReadAssets?.() !== true) {
    throw new PortalServiceError(
      'invalid_target',
      'The paired asset session is no longer authorized.',
    );
  }
}

function validateScope(projectId: string, worktreeId: string): void {
  validateId(projectId, 'projectId');
  validateId(worktreeId, 'worktreeId');
  if (
    [
      APP_ADVISOR_PROJECT_ID,
      PIPELINE_EDITOR_PROJECT_ID,
      SHARED_CONTAINER_VIEWER_PROJECT_ID,
    ].includes(projectId)
  ) {
    throw new PortalServiceError(
      'invalid_target',
      'Assets are unavailable for embedded or shared chats.',
    );
  }
}

function checkTarget(
  command: PortalCommandEnvelope<unknown>,
  projectId: string,
  worktreeId: string,
): void {
  if (
    command.target?.workspaceLocalId !== projectId ||
    command.target.worktreeLocalId !== worktreeId
  ) {
    throw new PortalServiceError(
      'invalid_target',
      'The asset target does not match the command target.',
    );
  }
}

type ChatAssetSource = { path: string; image: boolean } | { dataUrl: string };

export function resolveChatAssetSource(
  messages: readonly PersistedChatMessage[],
  assetId: string,
): ChatAssetSource | undefined {
  for (const message of messages) {
    if (!isVisiblePersistedChatMessage(message)) continue;
    if (message.role === 'user') {
      const paths = portalChatAttachmentPaths(message.attachmentPaths ?? []);
      const index = paths.findIndex(
        (path, candidate) =>
          portalChatAssetId(message.id, 'attachment', candidate) === assetId &&
          Boolean(path),
      );
      if (index >= 0) return { path: paths[index], image: false };
    }
    for (let index = 0; index < message.blocks.length; index += 1) {
      const block = message.blocks[index];
      if (
        block.type !== 'image' ||
        portalChatAssetId(message.id, 'image', index) !== assetId
      )
        continue;
      if (block.dataUrl !== undefined) return { dataUrl: block.dataUrl };
      if (block.path) return { path: block.path, image: true };
    }
  }
  return undefined;
}

export async function handlePortalChatAssetRead(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  try {
    requireAssetPermission(context);
    const payload = command.payload;
    if (
      !isRecord(payload) ||
      typeof payload.chatId !== 'string' ||
      typeof payload.assetId !== 'string' ||
      payload.assetId.length > 1024 ||
      !payload.assetId.startsWith('asset-')
    ) {
      throw new PortalServiceError(
        'invalid_payload',
        'Invalid chat asset payload.',
      );
    }
    const range = rangeFrom(payload);
    validateId(payload.chatId, 'chatId');
    let projectId: string;
    let worktreeId: string;
    if (payload.scope === 'standalone') {
      if (
        typeof payload.projectLocalId !== 'string' ||
        command.target?.standaloneChatLocalId !== payload.chatId ||
        command.target.workspaceLocalId !== undefined ||
        command.target.worktreeLocalId !== undefined
      ) {
        throw new PortalServiceError(
          'invalid_target',
          'Invalid standalone asset target.',
        );
      }
      validateId(payload.projectLocalId, 'projectLocalId');
      const resolved = await resolveStandaloneChatTarget({
        projectLocalId: payload.projectLocalId,
        chatId: payload.chatId,
      });
      if (!resolved.entryId || resolved.isArchived) {
        throw new PortalServiceError(
          'not_found',
          'The chat is no longer available.',
        );
      }
      projectId = resolved.workspaceId;
      worktreeId = resolved.entryId;
    } else {
      if (
        (payload.scope !== undefined && payload.scope !== 'worktree') ||
        typeof payload.projectId !== 'string' ||
        typeof payload.worktreeId !== 'string' ||
        command.target?.standaloneChatLocalId
      ) {
        throw new PortalServiceError(
          'invalid_payload',
          'Invalid worktree asset target.',
        );
      }
      projectId = payload.projectId;
      worktreeId = payload.worktreeId;
    }
    validateScope(projectId, worktreeId);
    if (payload.scope !== 'standalone')
      checkTarget(command, projectId, worktreeId);
    const state = await queryPortalChatState(context, {
      projectId,
      worktreeId,
    });
    const tab = state.tabsFile.tabs.find(
      (candidate) =>
        candidate.id === payload.chatId &&
        (candidate.kind ?? 'chat') === 'chat',
    );
    if (!tab)
      throw new PortalServiceError('not_found', 'The chat was not found.');
    let source = resolveChatAssetSource(tab.messages, payload.assetId);
    if (!source && (tab.transcript || tab.transcriptLoaded === false)) {
      let before: number | undefined;
      let transcriptRevision = tab.transcript?.transcriptRevision;
      let pages = 0;
      do {
        requireAssetPermission(context);
        const page = await queryPortalChatTranscriptPage(context, {
          projectId,
          worktreeId,
          chatId: payload.chatId,
          before,
          transcriptRevision,
        });
        source = resolveChatAssetSource(page.messages, payload.assetId);
        if (
          page.before !== undefined &&
          before !== undefined &&
          page.before >= before
        ) {
          throw new PortalServiceError(
            'execution_failed',
            'The transcript history could not be read safely.',
          );
        }
        before = page.before;
        transcriptRevision = page.transcriptRevision;
        pages += 1;
        if (pages > 1000)
          throw new PortalServiceError(
            'invalid_target',
            'The transcript history exceeds the asset lookup limit.',
          );
      } while (!source && before !== undefined);
    }
    if (!source)
      throw new PortalServiceError(
        'not_found',
        'This asset does not belong to the selected chat.',
      );
    requireAssetPermission(context);
    if ('dataUrl' in source) {
      const result = readPortalAssetDataUrl({
        assetId: payload.assetId,
        dataUrl: source.dataUrl,
        range,
        canRead: context.canReadAssets,
      });
      requireAssetPermission(context);
      context.complete(command, result);
      return;
    }
    if (!isAbsolute(source.path))
      throw new PortalServiceError(
        'invalid_target',
        'The original asset path is unavailable.',
      );
    const root = await resolvePortalChatAssetFileTarget({
      projectId,
      worktreeId,
      path: source.path,
    });
    if (!root && source.image) {
      const { codexHome } = await getCodexRuntimeService().getCanonicalState();
      const result = await readPortalAssetFile({
        path: source.path,
        root: join(codexHome, 'generated_images'),
        assetId: payload.assetId,
        range,
        canRead: context.canReadAssets,
      });
      requireAssetPermission(context);
      context.complete(command, result);
      return;
    }
    if (!root)
      throw new PortalServiceError(
        'invalid_target',
        'This asset is outside the selected chat roots.',
      );
    requireAssetPermission(context);
    const result = await readPortalAssetFile({
      path: source.path,
      root: root.absolutePath,
      excludedRoots: root.excludedDescendantRoots,
      assetId: payload.assetId,
      range,
      canRead: context.canReadAssets,
    });
    requireAssetPermission(context);
    context.complete(command, result);
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalFileAssetRead(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  try {
    requireAssetPermission(context);
    const payload = command.payload;
    if (
      !isRecord(payload) ||
      typeof payload.projectId !== 'string' ||
      typeof payload.worktreeId !== 'string' ||
      typeof payload.relativePath !== 'string' ||
      (payload.repoId !== undefined && typeof payload.repoId !== 'string') ||
      (payload.fileRootLocalId !== undefined &&
        typeof payload.fileRootLocalId !== 'string')
    ) {
      throw new PortalServiceError(
        'invalid_payload',
        'Invalid file asset payload.',
      );
    }
    validateScope(payload.projectId, payload.worktreeId);
    checkTarget(command, payload.projectId, payload.worktreeId);
    const range = rangeFrom(payload);
    const target = await resolvePortalFileTarget({
      projectId: payload.projectId,
      worktreeId: payload.worktreeId,
      relativePath: payload.relativePath,
      ...(typeof payload.repoId === 'string' ? { repoId: payload.repoId } : {}),
      ...(typeof payload.fileRootLocalId === 'string'
        ? { fileRootLocalId: payload.fileRootLocalId }
        : {}),
    });
    requireAssetPermission(context);
    const result = await readPortalAssetFile({
      path: target.joinedAbsolutePath,
      root: target.root.absolutePath,
      excludedRoots: target.root.excludedDescendantRoots,
      assetId: `file-${target.root.repoId}-${encodeURIComponent(target.relativePath)}`,
      range,
      canRead: context.canReadAssets,
    });
    requireAssetPermission(context);
    context.complete(command, result);
  } catch (error) {
    failServiceError(command, context, error);
  }
}
