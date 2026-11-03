import { z } from 'zod';

/*
 * Pipeline values both planes share: where a definition comes from and who
 * a run belongs to.
 */

export const PIPELINE_DEFINITION_SOURCES = [
  'bundled',
  'user',
  'curated',
  'workspace',
  'project',
  'shared',
] as const;

/** A serialized run owner: `personal` or `org:<uuid>`, in lower case. */
export const PipelineRunOwnerSchema = z
  .string()
  .regex(
    /^(personal|org:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
  );
