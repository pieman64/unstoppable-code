// Pending-attachment helpers for chat composer state.
import type {
  AttachmentMeta,
  ChatAttachmentPromptContext,
} from '@canopy/desktop-shared/types';
import { isChatAttachmentPromptKind } from '@canopy/desktop-shared/types';
import { getFilenameFromPath } from '@/lib/file-type';

export function buildAttachmentPromptContexts(
  attachments: readonly AttachmentMeta[] | undefined,
): ChatAttachmentPromptContext[] | undefined {
  const contexts =
    attachments
      ?.filter(
        (
          attachment,
        ): attachment is AttachmentMeta & {
          promptKind: NonNullable<AttachmentMeta['promptKind']>;
        } => isChatAttachmentPromptKind(attachment.promptKind),
      )
      .map((attachment) => ({
        attachmentPath: attachment.absolutePath,
        promptKind: attachment.promptKind,
      })) ?? [];
  return contexts.length > 0 ? contexts : undefined;
}

export function normalizeAttachmentPromptContexts(
  contexts: readonly ChatAttachmentPromptContext[] | undefined,
): ChatAttachmentPromptContext[] | undefined {
  if (!contexts || contexts.length === 0) {
    return undefined;
  }
  const byPath = new Map<string, ChatAttachmentPromptContext>();
  for (const context of contexts) {
    if (!isChatAttachmentPromptKind(context.promptKind)) {
      continue;
    }
    byPath.set(context.attachmentPath, context);
  }
  return byPath.size > 0 ? Array.from(byPath.values()) : undefined;
}

export function attachmentPromptContextsForPaths(
  contexts: readonly ChatAttachmentPromptContext[] | undefined,
  paths: readonly string[] | undefined,
): ChatAttachmentPromptContext[] | undefined {
  if (!paths || paths.length === 0) {
    return undefined;
  }
  const pathSet = new Set(paths);
  return normalizeAttachmentPromptContexts(
    contexts?.filter((context) => pathSet.has(context.attachmentPath)),
  );
}

export function uniqueAttachmentPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    unique.push(path);
  }
  return unique;
}

export function attachmentMetasFromPaths(
  paths: readonly string[] | undefined,
  contexts: readonly ChatAttachmentPromptContext[] | undefined,
): AttachmentMeta[] | undefined {
  if (!paths || paths.length === 0) {
    return undefined;
  }
  const promptKindByPath = new Map(
    (contexts ?? [])
      .filter((context) => isChatAttachmentPromptKind(context.promptKind))
      .map((context) => [context.attachmentPath, context.promptKind] as const),
  );
  return paths.map((path) => {
    const promptKind = promptKindByPath.get(path);
    return {
      filename: getFilenameFromPath(path),
      absolutePath: path,
      ...(promptKind ? { promptKind } : {}),
    };
  });
}

export function appendUniquePendingAttachments(
  current: AttachmentMeta[] | undefined,
  additions: readonly AttachmentMeta[],
): AttachmentMeta[] | undefined {
  const indexesByPath = new Map(
    current?.map((attachment, index) => [attachment.absolutePath, index]) ?? [],
  );
  let next: AttachmentMeta[] | undefined;

  for (const attachment of additions) {
    const existingIndex = indexesByPath.get(attachment.absolutePath);
    if (existingIndex !== undefined) {
      const existing = next?.[existingIndex] ?? current?.[existingIndex];
      if (!existing) {
        continue;
      }

      const merged = {
        ...existing,
        ...(attachment.sizeBytes !== undefined
          ? { sizeBytes: attachment.sizeBytes }
          : {}),
        ...(attachment.promptKind !== undefined
          ? { promptKind: attachment.promptKind }
          : {}),
      };
      if (
        merged.sizeBytes !== existing.sizeBytes ||
        merged.promptKind !== existing.promptKind
      ) {
        next = next ?? (current ? [...current] : []);
        next[existingIndex] = merged;
      }
      continue;
    }

    next = next ?? (current ? [...current] : []);
    next.push(attachment);
    indexesByPath.set(attachment.absolutePath, next.length - 1);
  }

  return next ?? current;
}
