import { parentPort, workerData } from 'node:worker_threads';
import Ajv, { type Options } from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import draft7MetaSchema from 'ajv/dist/refs/json-schema-draft-07.json';
import { fullFormats } from 'ajv-formats/dist/formats';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validate(): boolean {
  const request: unknown = workerData;
  if (
    !record(request) ||
    typeof request.schema !== 'string' ||
    typeof request.input !== 'string'
  )
    return false;
  const schema: unknown = JSON.parse(request.schema);
  const input: unknown = JSON.parse(request.input);
  if (!record(schema) && typeof schema !== 'boolean') return false;
  const declaredDialect = record(schema) ? schema.$schema : undefined;
  const dialect =
    typeof declaredDialect === 'string'
      ? declaredDialect.replace(/#$/, '')
      : declaredDialect;
  // MCP defaults to 2020-12. Explicit older supported dialects retain their semantics.
  const options: Options = {
    allErrors: false,
    strict: false,
    // Ajv logs unknown keywords in this mode but still throws for unknown formats.
    // Vendor annotations are legal JSON Schema; do not print server-supplied text.
    strictSchema: 'log',
    logger: false,
    ownProperties: true,
  };
  const ajv =
    dialect === undefined ||
    dialect === 'https://json-schema.org/draft/2020-12/schema'
      ? new Ajv2020(options)
      : dialect === 'https://json-schema.org/draft/2019-09/schema'
        ? new Ajv2019(options)
        : dialect === 'http://json-schema.org/draft-07/schema' ||
            dialect === 'https://json-schema.org/draft-07/schema'
          ? new Ajv(options)
          : undefined;
  if (!ajv) return false;
  if (dialect === 'https://json-schema.org/draft-07/schema')
    ajv.addMetaSchema(
      draft7MetaSchema,
      'https://json-schema.org/draft-07/schema',
    );
  for (const [name, format] of Object.entries(fullFormats))
    ajv.addFormat(name, format);
  const check = ajv.compile(schema);
  // Async schemas and unresolved references cannot authorize a call.
  return !('$async' in check && check.$async) && check(input) === true;
}

try {
  parentPort?.postMessage(validate());
} catch {
  parentPort?.postMessage(false);
}
