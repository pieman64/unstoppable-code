import type {
  PortalChatFileReference,
  PortalPipelineRunPayload,
} from '@canopy/protocol/portal';
import { PortalServiceError } from '../services/portal-service-error';
import { isRecord } from './adapters/validation';
import {
  portalFileReferences,
  type PortalFileReferenceScope,
} from './portal-file-references';

function validReference(
  reference: unknown,
): reference is PortalChatFileReference {
  return (
    isRecord(reference) &&
    typeof reference.referenceId === 'string' &&
    reference.referenceId.length > 0 &&
    reference.referenceId.length <= 128 &&
    typeof reference.displayPath === 'string' &&
    reference.displayPath.length > 0 &&
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

export function resolvePortalPipelineFileReferences(
  payload: PortalPipelineRunPayload,
  scope: PortalFileReferenceScope,
): PortalPipelineRunPayload {
  const { fileReferences, ...pipelinePayload } = payload;
  if (fileReferences === undefined) return pipelinePayload;
  if (
    !Array.isArray(fileReferences) ||
    fileReferences.length > 200 ||
    !fileReferences.every(validReference)
  )
    throw new PortalServiceError(
      'invalid_payload',
      'Invalid pipeline file references.',
    );
  if (fileReferences.length === 0) return pipelinePayload;
  const text = payload.eventData?.task_ready?.task_text;
  if (payload.eventName !== 'task_ready' || typeof text !== 'string')
    throw new PortalServiceError(
      'invalid_payload',
      'Pipeline file references require task-ready text.',
    );
  if (
    scope.canRead?.() !== true ||
    payload.projectId !== scope.projectId ||
    payload.worktreeId !== scope.worktreeId
  )
    throw new PortalServiceError(
      'invalid_target',
      'The destination must match the authorized command target.',
    );

  const replacements: Array<{ start: number; end: number; path: string }> = [];
  let searchStart = 0;
  for (const reference of fileReferences) {
    const resolved = portalFileReferences.resolve(scope, reference);
    const start =
      reference.textStart ?? text.indexOf(reference.displayPath, searchStart);
    const end = start + reference.displayPath.length;
    if (
      start < 0 ||
      text.slice(start, end) !== reference.displayPath ||
      replacements.some(
        (replacement) => start < replacement.end && end > replacement.start,
      )
    )
      throw new PortalServiceError(
        'invalid_payload',
        'The task text no longer matches its file references.',
      );
    replacements.push({ start, end, path: resolved.absolutePath });
    searchStart = end;
  }
  let taskText = text;
  for (const replacement of replacements.sort(
    (left, right) => right.start - left.start,
  ))
    taskText = `${taskText.slice(0, replacement.start)}${replacement.path}${taskText.slice(replacement.end)}`;
  return {
    ...pipelinePayload,
    eventData: {
      ...pipelinePayload.eventData,
      task_ready: { task_text: taskText },
    },
  };
}
