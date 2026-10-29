import { app } from 'electron';
import { spaceNotificationLevelSchema } from '@canopy/protocol/space-notifications';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  SpaceNotificationPolicySnapshot,
  SpaceNotificationScope,
  SpaceNotificationSetRequest,
  SpaceNotificationSetResult,
} from '@canopy/desktop-shared/types';
import { validateId } from '../lib/validation';
import { sendToAllWindows } from '../lib/window-send';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getSpaceNotificationPolicyService } from '../services/space-notification-policy-service';
import { registerIpcHandler } from './register';

function requestObject(value: unknown): object {
  if (typeof value !== 'object' || value === null)
    throw new Error('Invalid notification space');
  return value;
}

function validScope(value: unknown): SpaceNotificationScope {
  const request = requestObject(value);
  const projectId: unknown = Reflect.get(request, 'projectId');
  const worktreeId: unknown = Reflect.get(request, 'worktreeId');
  validateId(projectId, 'projectId');
  validateId(worktreeId, 'worktreeId');
  return { projectId, worktreeId };
}

function validSetRequest(value: unknown): SpaceNotificationSetRequest {
  const request = requestObject(value);
  const override = spaceNotificationLevelSchema
    .nullable()
    .parse(Reflect.get(request, 'override'));
  const expectedRevision: unknown = Reflect.get(request, 'expectedRevision');
  if (
    typeof expectedRevision !== 'number' ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  )
    throw new Error('Invalid expected revision');
  return { ...validScope(request), override, expectedRevision };
}

/**
 * Per-space notification choices (CAN-3615). Main owns the policy replica;
 * windows receive whole read-only snapshots and request refreshes or saves.
 */
export function registerSpaceNotificationHandlers(): void {
  const service = getSpaceNotificationPolicyService();
  service.subscribe((snapshot) => {
    sendToAllWindows(IPC_CHANNELS.spaceNotificationsChanged, snapshot);
  });
  registerIpcHandler<[], SpaceNotificationPolicySnapshot>(
    IPC_CHANNELS.spaceNotificationsGetSnapshot,
    () => service.getSnapshot(),
  );
  registerIpcHandler<[SpaceNotificationScope], SpaceNotificationPolicySnapshot>(
    IPC_CHANNELS.spaceNotificationsRefresh,
    (_event, scope) => service.refresh(validScope(scope)),
  );
  registerIpcHandler<[SpaceNotificationSetRequest], SpaceNotificationSetResult>(
    IPC_CHANNELS.spaceNotificationsSet,
    (_event, request) => service.set(validSetRequest(request)),
  );
  app.on('browser-window-focus', () => {
    service.onFocus();
  });
  void service.start().catch((error: unknown) => {
    logMainProcessWarn('[space-notifications] start failed', error);
  });
}
