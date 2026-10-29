import { z } from 'zod';
import { labsExperimentIdSchema } from '@canopy/protocol/experiments';

export const EXPERIMENT_ACTION_TYPES = ['experiments.set_enabled'] as const;
export const experimentActionSchema = z.strictObject({
  type: z.literal('experiments.set_enabled'),
  experimentId: labsExperimentIdSchema,
  enabled: z.boolean(),
});

export type ExperimentAction = z.output<typeof experimentActionSchema>;
