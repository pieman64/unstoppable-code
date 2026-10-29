import type {
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
} from '@canopy/desktop-shared/types';
import {
  listDirectory,
  listFileRoots,
  readPortalFilePreview,
  resolvePortalFileLink,
  savePortalFile,
  toFileSnapshotPayload,
} from '../../services/files-service';
import { createPortalEvent } from '../portal-event-bus';
import type { PortalAdapterContext } from './types';
import { failServiceError, isRecord } from './validation';

export async function handlePortalFileRoots(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.file.roots']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid file roots payload.');
    return;
  }
  try {
    context.complete(command, await listFileRoots(command.payload));
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalFileResolveLink(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.file.resolve_link']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid file link payload.');
    return;
  }
  try {
    context.complete(command, await resolvePortalFileLink(command.payload));
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalFileDirectory(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.file.directory']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid directory payload.');
    return;
  }
  try {
    const listing = await listDirectory(command.payload);
    context.enqueueEvent(
      createPortalEvent(
        'portal.file.snapshot',
        toFileSnapshotPayload(listing),
        { commandId: command.id },
      ),
    );
    context.complete(command, listing);
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalFileRead(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.file.read']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid file read payload.');
    return;
  }
  try {
    const preview = await readPortalFilePreview(command.payload);
    context.enqueueEvent(
      createPortalEvent(
        'portal.file.snapshot',
        toFileSnapshotPayload(preview),
        { commandId: command.id },
      ),
    );
    context.complete(command, preview);
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export const handlePortalFilePreview = handlePortalFileRead;

export async function handlePortalFileSave(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.file.save']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid file save payload.');
    return;
  }
  try {
    const preview = await savePortalFile(command.payload);
    context.enqueueEvent(
      createPortalEvent(
        'portal.file.snapshot',
        toFileSnapshotPayload(preview),
        { commandId: command.id },
      ),
    );
    context.complete(command, preview);
  } catch (error) {
    failServiceError(command, context, error);
  }
}
