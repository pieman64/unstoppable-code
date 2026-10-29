import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import schema from '@agentclientprotocol/sdk/schema/schema.json';

let validate: ValidateFunction | undefined;

/** Validate before the SDK can log a rejected notification or retain its credit. */
export function isValidAcpSessionUpdate(value: unknown): boolean {
  validate ??= new Ajv2020({
    strict: false,
    validateFormats: false,
    allErrors: false,
    logger: false,
    ownProperties: true,
  }).compile({
    $schema: schema.$schema,
    $defs: schema.$defs,
    $ref: '#/$defs/SessionNotification',
  });
  return validate(value) === true;
}
