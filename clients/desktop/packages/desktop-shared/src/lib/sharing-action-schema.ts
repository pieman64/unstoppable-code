import { z } from 'zod';
import { pipelineRepairShareTargetSchema } from '@canopy/protocol/capability-package-repair';

export const sharingOpenDialogSchema = z.object({
  type: z.literal('sharing.open_dialog'),
  target: z.union([
    z.object({
      kind: z.literal('skill'),
      name: z.string().trim().min(1).max(4096),
      sourceId: z.string().trim().min(1).max(4096).optional(),
    }),
    pipelineRepairShareTargetSchema,
    z.object({
      kind: z.literal('plugin'),
      marketplaceId: z.string().trim().min(1).max(4096),
      pluginName: z.string().trim().min(1).max(4096),
    }),
  ]),
});
