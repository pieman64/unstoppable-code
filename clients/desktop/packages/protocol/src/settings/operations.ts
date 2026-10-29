import type { z } from 'zod';
import {
  DEFAULT_SETTINGS_MAX_INPUT_BYTES,
  defineSettingsRead,
  settingsPathWithQuery,
  type AnySettingsOperation,
  type SettingsOperationRequest,
} from './operation-definition';
import {
  settingsBootstrapInputSchema,
  settingsBootstrapSchema,
} from './bootstrap';
import {
  settingsPageDataInputSchema,
  settingsPageDataSchema,
} from './page-data';
import { ACCOUNT_SETTINGS_OPERATIONS } from './operations-account';
import { ORGANIZATION_SETTINGS_OPERATIONS } from './operations-organization';

/** Session-authenticated settings routes added for hosted settings. */
export const SETTINGS_BOOTSTRAP_PATH = '/api/v1/settings/bootstrap';
export const SETTINGS_PAGE_DATA_PATH = '/api/v1/settings/page-data';

/**
 * The fixed table of hosted settings server calls. Financial operations
 * (setup intents, card mutation, charging, automatic top-up mutation,
 * subscription mutation and plan-change quotes) are deliberately absent: they
 * stay in the web billing modules behind `inlineCheckout`.
 */
export const SETTINGS_OPERATIONS = {
  ...ACCOUNT_SETTINGS_OPERATIONS,
  ...ORGANIZATION_SETTINGS_OPERATIONS,
  'settings.bootstrap': defineSettingsRead({
    transport: 'backend',
    input: settingsBootstrapInputSchema,
    result: settingsBootstrapSchema,
    request: (input) => ({
      method: 'GET',
      path: settingsPathWithQuery(SETTINGS_BOOTSTRAP_PATH, {
        organizationId: input.organizationId,
      }),
    }),
  }),
  'settings.pageData': defineSettingsRead({
    transport: 'backend',
    input: settingsPageDataInputSchema,
    result: settingsPageDataSchema,
    request: (input) => ({
      method: 'POST',
      path: SETTINGS_PAGE_DATA_PATH,
      body: { route: input.route },
    }),
  }),
} as const satisfies Record<string, AnySettingsOperation>;

type SettingsOperations = typeof SETTINGS_OPERATIONS;

export type SettingsOperationName = keyof SettingsOperations;

export type SettingsReadName = {
  [K in SettingsOperationName]: SettingsOperations[K]['kind'] extends 'read'
    ? K
    : never;
}[SettingsOperationName];

export type SettingsWriteName = {
  [K in SettingsOperationName]: SettingsOperations[K]['kind'] extends 'write'
    ? K
    : never;
}[SettingsOperationName];

/** Caller-facing input (before schema defaults and transforms). */
export type SettingsOperationInput<K extends SettingsOperationName> = z.input<
  SettingsOperations[K]['input']
>;

/** Validated result. */
export type SettingsOperationResult<K extends SettingsOperationName> = z.output<
  SettingsOperations[K]['result']
>;

export type SettingsReadMap = {
  [K in SettingsReadName]: {
    input: SettingsOperationInput<K>;
    result: SettingsOperationResult<K>;
  };
};

export type SettingsWriteMap = {
  [K in SettingsWriteName]: {
    input: SettingsOperationInput<K>;
    result: SettingsOperationResult<K>;
  };
};

export function isSettingsOperationName(
  value: unknown,
): value is SettingsOperationName {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(SETTINGS_OPERATIONS, value)
  );
}

export function isSettingsReadName(value: unknown): value is SettingsReadName {
  return (
    isSettingsOperationName(value) && settingsOperation(value).kind === 'read'
  );
}

export function isSettingsWriteName(
  value: unknown,
): value is SettingsWriteName {
  return (
    isSettingsOperationName(value) && settingsOperation(value).kind === 'write'
  );
}

/** The table entry for a name. */
export function settingsOperation(
  name: SettingsOperationName,
): AnySettingsOperation {
  return SETTINGS_OPERATIONS[name];
}

/** UTF-8 size of an input's JSON serialization. */
export function settingsInputByteLength(input: unknown): number {
  const serialized = JSON.stringify(input ?? null);
  return new TextEncoder().encode(serialized).byteLength;
}

export type SettingsInputValidation =
  | { ok: true; input: unknown }
  | { ok: false; reason: 'too_large' | 'invalid' };

/**
 * Validate untrusted input for an entry: refuse oversized input before
 * parsing, then parse with the entry's schema.
 */
export function validateSettingsOperationInput(
  name: SettingsOperationName,
  input: unknown,
): SettingsInputValidation {
  const operation = settingsOperation(name);
  const limit = operation.maxInputBytes ?? DEFAULT_SETTINGS_MAX_INPUT_BYTES;
  if (settingsInputByteLength(input) > limit)
    return { ok: false, reason: 'too_large' };
  const parsed = operation.input.safeParse(input);
  return parsed.success
    ? { ok: true, input: parsed.data }
    : { ok: false, reason: 'invalid' };
}

/** The request for already-validated input. */
export function settingsOperationRequest(
  name: SettingsOperationName,
  validatedInput: unknown,
): SettingsOperationRequest {
  return settingsOperation(name).request(validatedInput);
}

export type SettingsResultValidation =
  | { ok: true; result: unknown }
  | { ok: false };

/** Validate a server response against an entry's result schema. */
export function validateSettingsOperationResult(
  name: SettingsOperationName,
  response: unknown,
): SettingsResultValidation {
  const parsed = settingsOperation(name).result.safeParse(response);
  return parsed.success ? { ok: true, result: parsed.data } : { ok: false };
}
