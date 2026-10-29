import { z } from 'zod';

/**
 * Building blocks for {@link SETTINGS_OPERATIONS}. Each entry is a fixed,
 * named server call: hosts execute an entry by name with validated input and
 * never accept a URL, method, header, identity, or upload target from shared
 * UI or the desktop renderer.
 */
export type SettingsOperationKind = 'read' | 'write';

export type SettingsOperationMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE';

/**
 * How an entry reaches the server.
 *
 * - `backend`: a session-authenticated JSON route under the backend origin.
 * - `auth`: a Better Auth endpoint under `/api/auth/*`. Web calls it through
 *   its auth client; desktop main sends it from the isolated settings session
 *   with the configured web origin as `Origin`.
 * - `upload`: a signed-URL upload. The host asks the backend for a signed
 *   target, PUTs the validated bytes to it without account credentials, then
 *   commits through a backend route.
 */
export type SettingsOperationTransport = 'backend' | 'auth' | 'upload';

/** A request a host sends for one entry, derived from validated input. */
export interface SettingsOperationRequest {
  method: SettingsOperationMethod;
  /** Path plus query, relative to the backend origin. Always starts with `/`. */
  path: string;
  /** JSON body; `undefined` for bodiless requests. */
  body?: unknown;
}

/** Signed-upload description for `transport: 'upload'` entries. */
export interface SettingsUploadDefinition<TInput> {
  /** Largest accepted file, in bytes. Checked before the bytes are sent. */
  maxBytes: number;
  /** Accepted declared content types. */
  contentTypes: readonly string[];
  /** Backend request that returns the signed upload target. */
  sign: (input: TInput) => SettingsOperationRequest;
  /** Backend request that commits the uploaded object. */
  commit: (
    input: TInput,
    signed: SettingsSignedUpload,
  ) => SettingsOperationRequest;
}

export const settingsSignedUploadSchema = z.looseObject({
  uploadUrl: z.string().url(),
  /** Storage path the commit request names (the existing routes' field). */
  filePath: z.string().min(1).optional(),
  objectKey: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export type SettingsSignedUpload = z.infer<typeof settingsSignedUploadSchema>;

/**
 * The bytes of a `transport: 'upload'` entry, carried as the input's `file`
 * field: the `Blob` (a picked `File`) shared UI passes. The web client reads
 * it from the validated input; desktop strips the field before validating
 * and sends the bytes separately, so entries declare it optional.
 */
export const settingsUploadFileSchema = z.custom<Blob>(
  (value) => typeof Blob !== 'undefined' && value instanceof Blob,
);

export interface SettingsOperationDefinition<
  TKind extends SettingsOperationKind,
  TInputSchema extends z.ZodType,
  TResultSchema extends z.ZodType,
> {
  readonly kind: TKind;
  readonly transport: SettingsOperationTransport;
  readonly input: TInputSchema;
  readonly result: TResultSchema;
  /** Largest accepted serialized input, in bytes. Defaults to 64 KiB. */
  readonly maxInputBytes?: number;
  /**
   * A 401 from this entry means the server rejected a credential the user
   * typed (such as a wrong two-factor code), not that the session ended.
   * Hosts report it as `failed` and keep the session.
   */
  readonly rejectedCredentialOn401?: true;
  /** The request for validated input. Unused for `upload` entries. */
  readonly request: (input: z.output<TInputSchema>) => SettingsOperationRequest;
  readonly upload?: SettingsUploadDefinition<z.output<TInputSchema>>;
}

export type AnySettingsOperation = SettingsOperationDefinition<
  SettingsOperationKind,
  z.ZodType,
  z.ZodType
>;

export const DEFAULT_SETTINGS_MAX_INPUT_BYTES = 64 * 1024;

export function defineSettingsRead<
  TInputSchema extends z.ZodType,
  TResultSchema extends z.ZodType,
>(
  definition: Omit<
    SettingsOperationDefinition<'read', TInputSchema, TResultSchema>,
    'kind'
  >,
): SettingsOperationDefinition<'read', TInputSchema, TResultSchema> {
  return { kind: 'read', ...definition };
}

export function defineSettingsWrite<
  TInputSchema extends z.ZodType,
  TResultSchema extends z.ZodType,
>(
  definition: Omit<
    SettingsOperationDefinition<'write', TInputSchema, TResultSchema>,
    'kind'
  >,
): SettingsOperationDefinition<'write', TInputSchema, TResultSchema> {
  return { kind: 'write', ...definition };
}

/** Encode one path segment from validated input. */
export function settingsPathSegment(value: string | number): string {
  return encodeURIComponent(String(value));
}

/** Append defined query values to a path. */
export function settingsPathWithQuery(
  path: string,
  query: Readonly<Record<string, string | number | boolean | undefined | null>>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== null) params.set(key, String(value));
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

/** Empty input for parameterless entries. */
export const settingsEmptyInputSchema = z.strictObject({});

/** Result schema for routes whose body callers ignore (204 or `{ ok: true }`). */
export const settingsAcknowledgementSchema = z.union([
  z.null(),
  z.looseObject({}),
]);

/**
 * A result schema typed as an existing DTO. The structural `shape` validates
 * the fields hosts depend on (required ids, discriminants, arrays) and
 * tolerates additive fields; the DTO type stays the one the web route
 * already returns, so the table never forks a second definition of it.
 */
export function settingsDtoSchema<T>(shape: z.ZodType): z.ZodType<T> {
  return z.custom<T>((value) => shape.safeParse(value).success);
}
