import { z } from 'zod';

export const EDITOR_SETUP_ACTION_TYPES = [
  'navigation.open_editor_setup',
] as const;

/** Navigation only. Scanning and policy writes require the member's review. */
export const editorSetupActionSchema = z.strictObject({
  type: z.literal('navigation.open_editor_setup'),
  workspaceId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
});

export type EditorSetupAction = z.infer<typeof editorSetupActionSchema>;
