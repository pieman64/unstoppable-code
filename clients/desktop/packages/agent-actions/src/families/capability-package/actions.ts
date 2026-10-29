import { z } from 'zod';
import {
  capabilityRepairSubjectSchema,
  capabilityRepairAnalysisContextSchema,
} from '@canopy/protocol/capability-package-repair';

export const CAPABILITY_PACKAGE_ACTION_TYPES = [
  'capability_package.analyze',
] as const;
export const capabilityPackageAnalyzeSchema = z.strictObject({
  type: z.literal('capability_package.analyze'),
  subject: capabilityRepairSubjectSchema,
  context: capabilityRepairAnalysisContextSchema.optional(),
});
