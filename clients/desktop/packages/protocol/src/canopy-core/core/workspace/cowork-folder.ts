import { z } from 'zod';
import { defineCanopyInstruction, defineCanopyQuery } from '../../definitions';
import { CanopyErrorPayloadSchema } from '../../errors';

export const COWORK_FOLDER_MISSING_CODE = 'cowork_folder_missing';
export const CoworkFolderMissingSchema = z.strictObject({
  code: z.literal(COWORK_FOLDER_MISSING_CODE),
  workspaceId: z.string().min(1),
  folderName: z.string().min(1),
  message: z.string().min(1),
});
export type CoworkFolderMissing = z.output<typeof CoworkFolderMissingSchema>;
export const CoworkFolderStatusSchema = z.union([
  z.strictObject({ kind: z.literal('managed') }),
  z.strictObject({
    kind: z.literal('external'),
    status: z.literal('present'),
    folderName: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('external'),
    status: z.literal('missing'),
    folderName: z.string().min(1),
    code: z.literal(COWORK_FOLDER_MISSING_CODE),
    message: z.string().min(1),
  }),
]);
export type CoworkFolderStatus = z.output<typeof CoworkFolderStatusSchema>;

/** Served by the desktop core until the daemon has the Cowork root binding. */
export const CORE_COWORK_FOLDER_QUERIES = {
  'core.workspace.cowork.folder.check': defineCanopyQuery({
    plane: 'core',
    domain: 'workspace',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.workspace.read'],
    params: z.strictObject({ workspaceId: z.string().min(1).max(512) }),
    result: CoworkFolderStatusSchema,
    error: CanopyErrorPayloadSchema,
  }),
};

export const CoworkUnstartedSendSchema = z.strictObject({
  workspaceId: z.string().min(1).max(512),
  worktreeId: z.string().min(1).max(512),
  chatId: z.string().min(1).max(512),
  userMessageId: z.string().min(1).max(512),
  /** Only supplied when this attempt allocated the Work Entry. */
  entryCreatedAt: z.string().min(1).max(128).optional(),
});
export type CoworkUnstartedSend = z.output<typeof CoworkUnstartedSendSchema>;

export const CORE_COWORK_FOLDER_INSTRUCTIONS = {
  'core.workspace.cowork.send.rollback': defineCanopyInstruction({
    plane: 'core',
    domain: 'workspace',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.workspace.write'],
    params: CoworkUnstartedSendSchema,
    result: z.void(),
    error: CanopyErrorPayloadSchema,
  }),
};

/** Read only validated recovery data, including through trusted wrappers' causes. */
export function readCoworkFolderMissing(
  error: unknown,
): CoworkFolderMissing | undefined {
  let current = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 5 && !visited.has(current); depth++) {
    visited.add(current);
    try {
      if (typeof current !== 'object' || current === null) return undefined;
      const code: unknown = Reflect.get(current, 'code');
      const workspaceId: unknown = Reflect.get(current, 'workspaceId');
      const folderName: unknown = Reflect.get(current, 'folderName');
      const message: unknown = Reflect.get(current, 'message');
      const parsed = CoworkFolderMissingSchema.safeParse({
        code,
        workspaceId,
        folderName,
        message,
      });
      if (parsed.success) return parsed.data;
      current = Reflect.get(current, 'cause');
    } catch {
      return undefined;
    }
  }
  return undefined;
}
