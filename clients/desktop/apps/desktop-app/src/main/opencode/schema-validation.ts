import { join } from 'node:path';
import { createOpenCodeSchemaValidator } from '@canopy/desktop-shared/node/opencode/schema-validation';

/** Shared by interactive and delegated permission checks; no main-thread fallback. */
export const validateOpenCodeMcpSchema = createOpenCodeSchemaValidator(
  join(__dirname, 'opencode-schema-validation-worker.js'),
);
