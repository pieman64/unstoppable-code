import { sendToAllWindows } from '../lib/window-send';
import { z } from 'zod';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { ForeignActivityProjection } from '@canopy/protocol/foreign-activity';
import { validateId } from '../lib/validation';
import { getForeignActivityCarryoverService } from '../services/foreign-activity-carryover-service';
import { registerIpcHandler } from './register';

const stopSchema = z
  .object({
    epoch: z.string(),
    target: z
      .object({
        source: z.enum(['chat', 'pipeline', 'script']),
        operationId: z.string(),
        workspaceId: z.string(),
        worktreeId: z.string(),
        chatId: z.string().optional(),
        resultToken: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export function registerForeignActivityHandlers(): void {
  const service = getForeignActivityCarryoverService();
  service.subscribe((projection): void => {
    sendToAllWindows(IPC_CHANNELS.foreignActivityChanged, projection);
  });
  registerIpcHandler<[], ForeignActivityProjection>(
    IPC_CHANNELS.foreignActivityGet,
    async (): Promise<ForeignActivityProjection> => {
      await service.whenIdle();
      return service.get();
    },
  );
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.foreignActivityStop,
    async (_event, raw): Promise<void> => {
      const request = stopSchema.parse(raw);
      validateId(request.epoch, 'epoch');
      validateId(request.target.operationId, 'operation id');
      validateId(request.target.workspaceId, 'project id');
      validateId(request.target.worktreeId, 'worktree id');
      if (request.target.chatId !== undefined)
        validateId(request.target.chatId, 'chat id');
      await service.stop(request);
    },
  );
}
