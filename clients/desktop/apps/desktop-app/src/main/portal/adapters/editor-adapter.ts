import type {
  InvocableInventoryEntry,
  InvocableInventoryProvider,
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
  PortalChatFileReference,
  PortalEditorResolveInvocableResult,
  PortalInvocableChatTarget,
} from '@canopy/desktop-shared/types';
import {
  listChatInvocables,
  listEditorFileMentions,
  listEditorSlashCommands,
  prepareChatInvocable,
  resolveChatInvocable,
} from '../../services/editor-service';
import {
  enablePortalPluginRef,
  readInvocableChatTarget,
  rereadPortalChat,
  resolvePortalChat,
} from './chat-plugin-selections';
import type { PortalAdapterContext } from './types';
import { failServiceError, isRecord } from './validation';
import { portalFileReferences } from '../portal-file-references';
import { rebindPortalFileReferences } from '../portal-file-reference-rebind';
import { PortalServiceError } from '../../services/portal-service-error';

function validFileReference(
  reference: unknown,
): reference is PortalChatFileReference {
  return (
    isRecord(reference) &&
    typeof reference.referenceId === 'string' &&
    reference.referenceId.length > 0 &&
    reference.referenceId.length <= 128 &&
    typeof reference.displayPath === 'string' &&
    reference.displayPath.length <= 4096 &&
    reference.absolutePath === undefined &&
    (reference.repoName === undefined ||
      typeof reference.repoName === 'string') &&
    (reference.kind === undefined || typeof reference.kind === 'string') &&
    (reference.textStart === undefined ||
      (typeof reference.textStart === 'number' &&
        Number.isSafeInteger(reference.textStart) &&
        reference.textStart >= 0))
  );
}

function isInvocableProvider(
  value: unknown,
): value is InvocableInventoryProvider {
  return (
    value === 'claude' ||
    value === 'codex' ||
    value === 'ollama' ||
    value === 'cursor' ||
    value === 'copilot' ||
    value === 'opencode'
  );
}

type InvocableRequestRead =
  | {
      ok: true;
      target: PortalInvocableChatTarget;
      providerType?: InvocableInventoryProvider;
    }
  | { ok: false };

/** Validate the shared target and provider scope of an inventory command. */
function readInvocableRequest(payload: unknown): InvocableRequestRead {
  if (!isRecord(payload)) return { ok: false };
  const target = readInvocableChatTarget(payload.target);
  const providerType: unknown = payload.providerType;
  if (
    !target ||
    (providerType !== undefined && !isInvocableProvider(providerType))
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    target,
    ...(isInvocableProvider(providerType) ? { providerType } : {}),
  };
}

export async function handlePortalEditorListSlashCommands(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.editor.list_slash_commands']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid editor slash-commands payload.',
    );
    return;
  }
  try {
    const commands = await listEditorSlashCommands(command.payload, {
      sessionId: context.sessionId ?? '',
    });
    context.complete(command, { commands });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalEditorListFileMentions(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.editor.list_file_mentions']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid editor file-mentions payload.',
    );
    return;
  }
  try {
    const scope = {
      sessionId: context.sessionId ?? '',
      projectId: command.payload.projectId,
      worktreeId: command.payload.worktreeId,
      canRead: context.canReadAssets,
    };
    if (context.canReadAssets?.() !== true)
      throw new PortalServiceError(
        'invalid_target',
        'This paired session cannot read file references.',
      );
    if (
      command.payload.rebind !== undefined &&
      command.payload.selector !== undefined
    )
      throw new PortalServiceError(
        'invalid_payload',
        'Select or rebind file references, not both.',
      );
    if (command.payload.selector !== undefined) {
      const selector = command.payload.selector;
      if (
        !isRecord(selector) ||
        typeof selector.repoId !== 'string' ||
        !selector.repoId ||
        typeof selector.relativePath !== 'string' ||
        (selector.kind !== 'file' && selector.kind !== 'directory') ||
        ('absolutePath' in selector && selector.absolutePath !== undefined)
      )
        throw new PortalServiceError(
          'invalid_payload',
          'Invalid file-reference selector payload.',
        );
      if (
        command.target?.workspaceLocalId !== scope.projectId ||
        command.target.worktreeLocalId !== scope.worktreeId
      )
        throw new PortalServiceError(
          'invalid_target',
          'The destination must match the authorized command target.',
        );
    }
    if (command.payload.rebind !== undefined) {
      const rebind = command.payload.rebind;
      if (
        !isRecord(rebind) ||
        typeof rebind.sourceProjectId !== 'string' ||
        !rebind.sourceProjectId ||
        typeof rebind.sourceWorktreeId !== 'string' ||
        !rebind.sourceWorktreeId ||
        !Array.isArray(rebind.fileReferences) ||
        rebind.fileReferences.length > 200 ||
        !rebind.fileReferences.every(validFileReference)
      )
        throw new PortalServiceError(
          'invalid_payload',
          'Invalid file-reference rebind payload.',
        );
      if (
        command.target?.workspaceLocalId !== scope.projectId ||
        command.target.worktreeLocalId !== scope.worktreeId
      )
        throw new PortalServiceError(
          'invalid_target',
          'The destination must match the authorized command target.',
        );
      const fileReferences = await rebindPortalFileReferences({
        sourceScope: {
          ...scope,
          projectId: rebind.sourceProjectId,
          worktreeId: rebind.sourceWorktreeId,
        },
        destinationScope: scope,
        fileReferences: rebind.fileReferences,
      });
      context.complete(command, { files: [], fileReferences });
      return;
    }
    const files = await listEditorFileMentions(command.payload, scope);
    context.complete(command, {
      files: files.map((file) => {
        const reference = portalFileReferences.mint(scope, {
          displayPath: file.relativePath || file.repoName,
          absolutePath: file.absolutePath,
          repoName: file.repoName,
          ...(file.kind ? { kind: file.kind } : {}),
        });
        return {
          referenceId: reference.referenceId,
          repoId: file.repoId,
          repoName: file.repoName,
          relativePath: file.relativePath,
          filename: file.filename,
          ...(file.kind ? { kind: file.kind } : {}),
          ...(file.isAttachment !== undefined
            ? { isAttachment: file.isAttachment }
            : {}),
        };
      }),
    });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalEditorListInvocables(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const read = readInvocableRequest(command.payload);
  if (!read.ok) {
    context.fail(command, 'invalid_payload', 'Invalid invocable list payload.');
    return;
  }
  const chat = await resolvePortalChat(command, context, read.target);
  if (!chat) return;
  try {
    context.complete(
      command,
      await listChatInvocables({
        scope: chat.scope,
        tab: chat.tab,
        session: { sessionId: context.sessionId ?? '' },
        ...(read.providerType ? { providerType: read.providerType } : {}),
      }),
    );
  } catch (error) {
    failServiceError(command, context, error);
  }
}

/**
 * Enable and resolve one inventory row for a chat. The enabling selection is
 * committed durably before the insert text is returned, so a client never
 * inserts text for an item the chat cannot run.
 */
export async function handlePortalEditorResolveInvocable(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const read = readInvocableRequest(command.payload);
  const entryId: unknown = isRecord(command.payload)
    ? command.payload.entryId
    : undefined;
  if (
    !read.ok ||
    typeof entryId !== 'string' ||
    entryId.length === 0 ||
    entryId.length > 1_024
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid invocable resolve payload.',
    );
    return;
  }
  const chat = await resolvePortalChat(command, context, read.target);
  if (!chat) return;
  let entry: InvocableInventoryEntry;
  try {
    entry = await prepareChatInvocable({
      tab: chat.tab,
      entryId,
      ...(read.providerType ? { providerType: read.providerType } : {}),
    });
  } catch (error) {
    failServiceError(command, context, error);
    return;
  }
  // The text and the enabling patch use one selection snapshot, read after
  // preparation: a provider can name the item by its place in the selections.
  const latest = await rereadPortalChat(command, context, chat);
  if (!latest) return;
  let resolved: Awaited<ReturnType<typeof resolveChatInvocable>>;
  try {
    resolved = await resolveChatInvocable({ ...latest, entry });
  } catch (error) {
    failServiceError(command, context, error);
    return;
  }
  const result: PortalEditorResolveInvocableResult = {
    insertText: resolved.insertText,
    invocationKey: resolved.invocationKey,
  };
  if (resolved.enableRef) {
    const selections = await enablePortalPluginRef(
      command,
      context,
      latest,
      resolved.enableRef,
    );
    if (!selections) return;
    result.pluginSelections = selections;
  }
  context.complete(command, result);
}
