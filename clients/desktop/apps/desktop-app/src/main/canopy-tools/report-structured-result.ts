// The ajv-backed JSON schema validator is desktop-shared so that
// packages/desktop-shared/src/node/pipelines/cursor-prompt-runner.ts can
// enforce a pipeline step's requested structured_output_schema the same way
// App Advisor's own structured tool results do (PR #3683). Re-exported here
// so existing App Advisor call sites and tests are unaffected.
export {
  normalizeAjvDataPath,
  validateAgainstSchema,
  type SchemaValidationResult,
} from '@canopy/desktop-shared/lib/ajv-schema-validator';
