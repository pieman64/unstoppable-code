import { createHash } from 'node:crypto';
import {
  getTriggerTypes,
  normalizePipeline,
  parsePipelineText,
  serializePipelineDocument,
  type NormalizePipelineOptions,
  type Pipeline,
} from '@canopy/pipeline-interop';
import {
  PIPELINE_DEFINITION_DIAGNOSTIC_CODES,
  PIPELINE_DEFINITION_DOCUMENT_MAX_LENGTH,
  PIPELINE_DEFINITION_LIST_DEFAULT_LIMIT,
  PIPELINE_DEFINITION_SOURCES,
  PIPELINE_DEFINITION_TRIGGER_TYPES,
  type CanopyErrorKind,
  type CanopyWorkspaceScope,
  type PipelineDefinition,
  type PipelineDefinitionDiagnostic,
  type PipelineDefinitionDocument,
  type PipelineDefinitionDeleteParams,
  type PipelineDefinitionDeleteResult,
  type PipelineDefinitionFormat,
  type PipelineDefinitionInstructionErrorCode,
  type PipelineDefinitionListParams,
  type PipelineDefinitionListResult,
  type PipelineDefinitionSource,
  type PipelineDefinitionSummary,
  type PipelineDefinitionUpsertParams,
  type PipelineDefinitionValidateResult,
} from '@canopy/protocol/canopy-core';
import { isSharedPipelineLocalId } from '@canopy/protocol/pipelines';
import { CanopyOperationError } from '../../runtime/errors';

/** One definition a source can list without reading its document. */
export interface PipelineDefinitionSourceEntry {
  readonly source: PipelineDefinitionSource;
  readonly definitionId: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly readonly: boolean;
  readonly revision: number;
  readonly owner: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /** Recorded metadata; derived from the document when absent. */
  readonly triggerTypes?: readonly PipelineDefinitionSummary['triggerTypes'][number][];
  readonly executionScopes?: readonly PipelineDefinitionSummary['executionScopes'][number][];
  /** Checksum of the document when the source knows it without a read. */
  readonly checksum?: string;
}

export interface PipelineDefinitionSourceDocument extends PipelineDefinitionSourceEntry {
  readonly format: PipelineDefinitionFormat;
  readonly text: string;
}

export interface PipelineDefinitionSourceContext {
  readonly scope: CanopyWorkspaceScope;
  readonly signal: AbortSignal;
  /** The port's sources this call asked for; a port reads only these. */
  readonly sources: readonly PipelineDefinitionSource[];
}

/**
 * A host binding for one or more definition sources. The host stays the
 * reader and writer of each source's storage and applies its own
 * resource-context visibility; core owns which source a definition id
 * resolves to, validation, and the canonical record.
 */
export interface PipelineDefinitionSourcePort {
  readonly sources: readonly PipelineDefinitionSource[];
  /**
   * A failing optional source is reported in `unavailableSources` and never
   * hides the others, as an unavailable account or catalog never hides local
   * pipelines. A failing required source fails the list.
   */
  readonly optional?: boolean;
  list(
    context: PipelineDefinitionSourceContext,
  ): Promise<readonly PipelineDefinitionSourceEntry[]>;
  /** `null` when the source has no such definition. */
  read(
    source: PipelineDefinitionSource,
    definitionId: string,
    context: PipelineDefinitionSourceContext,
  ): Promise<PipelineDefinitionSourceDocument | null>;
}

/** A validated document for the writable source to store. */
export interface PipelineDefinitionWrite {
  /** `null` creates a definition under a new id. */
  readonly definitionId: string | null;
  /** `null` writes without a revision precondition. */
  readonly expectedRevision: number | null;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  /** The document text to keep verbatim; a parsed document is serialized. */
  readonly text: string;
  readonly pipeline: Pipeline;
}

export interface PipelineDefinitionWriteContext {
  readonly scope: CanopyWorkspaceScope;
  readonly signal: AbortSignal;
}

/**
 * The host binding for the writable `user` source. The host stays its
 * writer and refuses a stale `expectedRevision` with `revisionConflict`, a
 * bundled id with `definitionReadOnly` and an unknown id with
 * `definitionNotFound`; core validates the document first.
 */
export interface PipelineDefinitionWritePort {
  upsert(
    write: PipelineDefinitionWrite,
    context: PipelineDefinitionWriteContext,
  ): Promise<PipelineDefinitionSourceDocument>;
  /** The stored revision of a user definition; `null` when there is none. */
  revision(definitionId: string): Promise<number | null>;
  /** Returns the revision the deleted definition had. */
  delete(
    definitionId: string,
    expectedRevision: number | null,
    context: PipelineDefinitionWriteContext,
  ): Promise<number>;
}

/**
 * A write that committed before a later step failed. Retrying its request
 * runs `resume` to finish that step instead of writing again.
 */
export class PipelineDefinitionResumableWrite extends Error {
  constructor(
    message: string,
    readonly resume: () => Promise<PipelineDefinition>,
  ) {
    super(message);
    this.name = 'PipelineDefinitionResumableWrite';
  }
}

/** A source failure with a stable code and a message safe for its caller. */
export class PipelineDefinitionSourceError extends Error {
  constructor(
    readonly code: PipelineDefinitionInstructionErrorCode,
    message: string,
    readonly sourceCause?: unknown,
  ) {
    super(message);
    this.name = 'PipelineDefinitionSourceError';
  }
}

export interface PipelineDefinitionServiceOptions {
  readonly ports: readonly PipelineDefinitionSourcePort[];
  /** Ids the host has disabled; every other definition is enabled. */
  readonly disabledDefinitionIds?: () => Promise<ReadonlySet<string>>;
  /** Host normalization inputs, such as the platform's default shell. */
  readonly normalizeOptions?: () => NormalizePipelineOptions;
  /** The execution targets this host serves; `null` targets always pass. */
  readonly servingTargetIds?: readonly string[];
  /** The writable `user` source; without it every write is refused. */
  readonly writer?: PipelineDefinitionWritePort;
  /** Records a definition's enabled state; required to disable one. */
  readonly setDefinitionEnabled?: (
    definitionId: string,
    enabled: boolean,
  ) => Promise<void>;
}

const SOURCE_ORDER = new Map<PipelineDefinitionSource, number>(
  PIPELINE_DEFINITION_SOURCES.map((source, index) => [source, index]),
);
// Listing order: the local stores first, then a checkout's own definitions,
// then account-backed ones.
const LIST_ORDER: readonly PipelineDefinitionSource[] = [
  'bundled',
  'user',
  'project',
  'workspace',
  'curated',
  'shared',
];

const ERROR_KINDS: Record<
  PipelineDefinitionInstructionErrorCode,
  CanopyErrorKind
> = {
  'core.pipeline.definitionNotFound': 'not_found',
  'core.pipeline.definitionUnreadable': 'failed_precondition',
  'core.pipeline.sourceUnavailable': 'unavailable',
  'core.pipeline.scopeInvalid': 'invalid_argument',
  'core.pipeline.contextMismatch': 'permission_denied',
  'core.pipeline.targetUnavailable': 'capability_unavailable',
  'core.pipeline.definitionInvalid': 'invalid_argument',
  'core.pipeline.definitionReadOnly': 'failed_precondition',
  'core.pipeline.revisionConflict': 'conflict',
};

/** A typed operation error that keeps the source failure as its cause. */
export function pipelineDefinitionError(
  code: PipelineDefinitionInstructionErrorCode,
  message: string,
  cause?: unknown,
): CanopyOperationError {
  const kind = ERROR_KINDS[code];
  return new CanopyOperationError(
    {
      kind,
      code,
      message: message.slice(0, 4_096) || 'The workflow could not be read.',
      retry:
        kind === 'unavailable'
          ? { kind: 'same_request' }
          : kind === 'conflict'
            ? { kind: 'after_refresh', resource: 'core.pipeline.definition' }
            : { kind: 'never' },
    },
    cause,
  );
}

function toOperationError(error: unknown, fallback: string): unknown {
  if (error instanceof CanopyOperationError) return error;
  if (error instanceof PipelineDefinitionSourceError)
    return pipelineDefinitionError(error.code, error.message, error);
  return pipelineDefinitionError(
    'core.pipeline.sourceUnavailable',
    fallback,
    error,
  );
}

/**
 * The sources a definition id can name, in precedence order. Curated, shared
 * and project ids carry their source in their prefix; a bare id is a user
 * definition first and a bundled one second, as the local store resolves it.
 * Stored ids never carry the project prefix, so a project definition never
 * shadows a stored one in practice.
 */
export function pipelineDefinitionSourcesForId(
  definitionId: string,
): readonly PipelineDefinitionSource[] {
  if (definitionId.startsWith('curated:')) return ['curated'];
  if (isSharedPipelineLocalId(definitionId)) return ['shared'];
  if (definitionId.startsWith('project--')) return ['project'];
  return ['user', 'bundled'];
}

export function pipelineDefinitionChecksum(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseDocument(
  document: PipelineDefinitionDocument,
):
  | { pipeline: Pipeline; diagnostic?: undefined }
  | { pipeline?: undefined; diagnostic: PipelineDefinitionDiagnostic } {
  try {
    return {
      pipeline: parsePipelineText(
        typeof document === 'string' ? document : JSON.stringify(document),
      ),
    };
  } catch (error) {
    return {
      diagnostic: {
        severity: 'error',
        code: PIPELINE_DEFINITION_DIAGNOSTIC_CODES.parseFailed,
        message: errorMessage(error).slice(0, 8_192),
      },
    };
  }
}

interface Validation {
  readonly pipeline: Pipeline | null;
  readonly normalized: Record<string, unknown> | null;
  readonly diagnostics: PipelineDefinitionDiagnostic[];
}

function jsonRecord(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? { ...parsed }
    : {};
}

function validate(
  document: PipelineDefinitionDocument,
  options: NormalizePipelineOptions,
): Validation {
  const parsed = parseDocument(document);
  if (!parsed.pipeline)
    return {
      pipeline: null,
      normalized: null,
      diagnostics: [parsed.diagnostic],
    };
  try {
    return {
      pipeline: parsed.pipeline,
      normalized: jsonRecord(normalizePipeline(parsed.pipeline, options)),
      diagnostics: [],
    };
  } catch (error) {
    return {
      pipeline: parsed.pipeline,
      normalized: null,
      diagnostics: [
        {
          severity: 'error',
          code: PIPELINE_DEFINITION_DIAGNOSTIC_CODES.definitionInvalid,
          message: errorMessage(error).slice(0, 8_192),
        },
      ],
    };
  }
}

function executionScopesOf(
  normalized: Record<string, unknown> | null,
): PipelineDefinitionSummary['executionScopes'] {
  const scope = normalized?.scope;
  if (!Array.isArray(scope)) return ['directory'];
  return scope.filter(
    (value): value is PipelineDefinitionSummary['executionScopes'][number] =>
      value === 'global' || value === 'directory' || value === 'worktree',
  );
}

/** Trigger types a summary can carry; an invalid stored `on:` is diagnosed, not listed. */
function knownTriggerTypes(
  types: readonly string[],
): PipelineDefinitionSummary['triggerTypes'] {
  return types.filter(
    (type): type is PipelineDefinitionSummary['triggerTypes'][number] =>
      PIPELINE_DEFINITION_TRIGGER_TYPES.some((known) => known === type),
  );
}

function hasProjectScope(scope: CanopyWorkspaceScope): boolean {
  return scope.workspaceId !== undefined && scope.worktreeId !== undefined;
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(0|[1-9][0-9]{0,8})$/.test(cursor))
    throw new CanopyOperationError({
      kind: 'invalid_argument',
      message: 'The list cursor is invalid.',
      retry: { kind: 'never' },
    });
  return Number(cursor);
}

function matchesQuery(
  summary: PipelineDefinitionSummary,
  query: string | undefined,
): boolean {
  const needle = query?.trim().toLowerCase();
  if (!needle) return true;
  return [summary.definitionId, summary.name, summary.description].some(
    (value) => value.toLowerCase().includes(needle),
  );
}

export interface PipelineDefinitionService {
  list(
    params: PipelineDefinitionListParams,
    signal: AbortSignal,
  ): Promise<PipelineDefinitionListResult>;
  get(
    definitionId: string,
    scope: CanopyWorkspaceScope,
    signal: AbortSignal,
  ): Promise<PipelineDefinition>;
  validate(
    document: PipelineDefinitionDocument,
    targetId: string | null,
  ): PipelineDefinitionValidateResult;
  upsert(
    params: Omit<PipelineDefinitionUpsertParams, '_meta'>,
    signal: AbortSignal,
  ): Promise<PipelineDefinition>;
  delete(
    params: Omit<PipelineDefinitionDeleteParams, '_meta'>,
    signal: AbortSignal,
  ): Promise<PipelineDefinitionDeleteResult>;
}

export function createPipelineDefinitionService(
  options: PipelineDefinitionServiceOptions,
): PipelineDefinitionService {
  const portFor = (
    source: PipelineDefinitionSource,
  ): PipelineDefinitionSourcePort | undefined =>
    options.ports.find((port) => port.sources.includes(source));
  const normalizeOptions = (): NormalizePipelineOptions =>
    options.normalizeOptions?.() ?? {};
  const disabledIds = async (): Promise<ReadonlySet<string>> =>
    (await options.disabledDefinitionIds?.()) ?? new Set();

  const summarize = (
    entry: PipelineDefinitionSourceEntry,
    scope: CanopyWorkspaceScope,
    disabled: ReadonlySet<string>,
    derived: {
      checksum?: string;
      triggerTypes?: PipelineDefinitionSummary['triggerTypes'];
      executionScopes?: PipelineDefinitionSummary['executionScopes'];
      format?: PipelineDefinitionFormat;
    } = {},
  ): PipelineDefinitionSummary => ({
    definitionId: entry.definitionId,
    scope: entry.source === 'project' ? scope : {},
    source: entry.source,
    owner: entry.owner,
    name: entry.name,
    description: entry.description,
    icon: entry.icon,
    enabled: !disabled.has(entry.definitionId),
    readonly: entry.readonly,
    format: derived.format ?? 'yaml',
    revision: entry.revision,
    checksum: derived.checksum ?? entry.checksum ?? null,
    triggerTypes: [
      ...knownTriggerTypes(
        entry.triggerTypes ?? derived.triggerTypes ?? ['dispatch'],
      ),
    ],
    executionScopes: [
      ...(entry.executionScopes ?? derived.executionScopes ?? ['directory']),
    ],
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });

  const read = async (
    definitionId: string,
    scope: CanopyWorkspaceScope,
    signal: AbortSignal,
  ): Promise<PipelineDefinitionSourceDocument> => {
    for (const source of pipelineDefinitionSourcesForId(definitionId)) {
      const port = portFor(source);
      if (!port) continue;
      if (source === 'project' && !hasProjectScope(scope))
        throw pipelineDefinitionError(
          'core.pipeline.scopeInvalid',
          'A project workflow needs a workspace and worktree scope.',
        );
      let document: PipelineDefinitionSourceDocument | null;
      try {
        document = await port.read(source, definitionId, {
          scope,
          signal,
          sources: [source],
        });
      } catch (error) {
        throw toOperationError(error, 'The workflow could not be read.');
      }
      if (document) return document;
    }
    throw pipelineDefinitionError(
      'core.pipeline.definitionNotFound',
      `Workflow not found: ${definitionId}`,
    );
  };

  const definitionFrom = async (
    document: PipelineDefinitionSourceDocument,
    scope: CanopyWorkspaceScope,
  ): Promise<PipelineDefinition> => {
    const validation = validate(document.text, normalizeOptions());
    const checksum =
      document.checksum ?? pipelineDefinitionChecksum(document.text);
    const summary = summarize(document, scope, await disabledIds(), {
      checksum,
      format: document.format,
      triggerTypes: validation.pipeline
        ? getTriggerTypes(validation.pipeline.on)
        : undefined,
      executionScopes: validation.normalized
        ? executionScopesOf(validation.normalized)
        : undefined,
    });
    return {
      ...summary,
      checksum,
      document: document.text,
      normalized: validation.normalized,
      diagnostics: validation.diagnostics,
    };
  };

  // Writes to one definition, with their enablement, run one at a time in
  // this process, so enablement lands in revision order.
  const locks = new Map<string, Promise<unknown>>();
  const withDefinitionLock = async <T>(
    definitionId: string | null,
    run: () => Promise<T>,
  ): Promise<T> => {
    if (definitionId === null) return run();
    const previous = locks.get(definitionId) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.catch((): void => undefined);
    locks.set(definitionId, settled);
    try {
      return await next;
    } finally {
      if (locks.get(definitionId) === settled) locks.delete(definitionId);
    }
  };

  // Only the user store is writable: curated, shared and project ids name
  // read-only sources whatever their content.
  const writerFor = (
    definitionId: string | null,
  ): PipelineDefinitionWritePort => {
    if (
      definitionId !== null &&
      !pipelineDefinitionSourcesForId(definitionId).includes('user')
    )
      throw pipelineDefinitionError(
        'core.pipeline.definitionReadOnly',
        `This workflow is read-only: ${definitionId}`,
      );
    if (!options.writer)
      throw pipelineDefinitionError(
        'core.pipeline.sourceUnavailable',
        'This host cannot save workflows.',
      );
    return options.writer;
  };

  return {
    async list(params, signal): Promise<PipelineDefinitionListResult> {
      const scope = params.scope ?? {};
      const requested = new Set(params.sources ?? PIPELINE_DEFINITION_SOURCES);
      const offset = decodeCursor(params.cursor);
      const limit = params.limit ?? PIPELINE_DEFINITION_LIST_DEFAULT_LIMIT;
      const ports = options.ports.filter((port) =>
        port.sources.some(
          (source) =>
            requested.has(source) &&
            (source !== 'project' || hasProjectScope(scope)),
        ),
      );
      const unavailable = new Set<PipelineDefinitionSource>();
      const listed = await Promise.all(
        ports.map(async (port) => {
          try {
            return await port.list({
              scope,
              signal,
              sources: port.sources.filter((source) => requested.has(source)),
            });
          } catch (error) {
            if (!port.optional)
              throw toOperationError(
                error,
                'The workflows could not be listed.',
              );
            for (const source of port.sources)
              if (requested.has(source)) unavailable.add(source);
            return [];
          }
        }),
      );
      const disabled = await disabledIds();
      const rank = (source: PipelineDefinitionSource): number =>
        LIST_ORDER.indexOf(source);
      const rows = listed
        .flatMap((entries, portIndex) =>
          entries.map((entry, index) => ({ entry, portIndex, index })),
        )
        .filter(({ entry }) => requested.has(entry.source))
        .sort(
          (left, right) =>
            rank(left.entry.source) - rank(right.entry.source) ||
            left.portIndex - right.portIndex ||
            left.index - right.index,
        )
        .map(({ entry }) => summarize(entry, scope, disabled))
        .filter(
          (summary) =>
            (params.enabled === undefined ||
              summary.enabled === params.enabled) &&
            matchesQuery(summary, params.query),
        );
      const page = rows.slice(offset, offset + limit);
      return {
        items: page,
        nextCursor:
          offset + limit < rows.length ? String(offset + limit) : null,
        unavailableSources: Array.from(unavailable).sort(
          (left, right) =>
            (SOURCE_ORDER.get(left) ?? 0) - (SOURCE_ORDER.get(right) ?? 0),
        ),
      };
    },

    validate(document, targetId): PipelineDefinitionValidateResult {
      if (
        targetId !== null &&
        !(options.servingTargetIds ?? []).includes(targetId)
      )
        throw pipelineDefinitionError(
          'core.pipeline.targetUnavailable',
          'This host does not serve the selected execution target.',
        );
      const validation = validate(document, normalizeOptions());
      return {
        valid: validation.diagnostics.length === 0,
        normalized: validation.normalized,
        diagnostics: validation.diagnostics,
      };
    },

    async get(definitionId, scope, signal): Promise<PipelineDefinition> {
      return definitionFrom(await read(definitionId, scope, signal), scope);
    },

    async upsert(params, signal): Promise<PipelineDefinition> {
      const writer = writerFor(params.definitionId);
      const setEnabled = options.setDefinitionEnabled;
      if (params.enabled !== undefined && !setEnabled)
        throw pipelineDefinitionError(
          'core.pipeline.sourceUnavailable',
          'This host cannot change whether a workflow is enabled.',
        );
      const validation = validate(params.document, normalizeOptions());
      const diagnostic = validation.diagnostics[0];
      if (!validation.pipeline || diagnostic)
        throw pipelineDefinitionError(
          'core.pipeline.definitionInvalid',
          diagnostic?.message ?? 'The workflow is invalid.',
        );
      const pipeline = validation.pipeline;
      // The stored text is what `get` returns, so it must fit a result.
      const text =
        typeof params.document === 'string'
          ? params.document
          : serializePipelineDocument(pipeline);
      if (text.length > PIPELINE_DEFINITION_DOCUMENT_MAX_LENGTH)
        throw pipelineDefinitionError(
          'core.pipeline.definitionInvalid',
          'The workflow document is larger than 1 MiB.',
        );
      const context = { scope: params.scope, signal };
      return withDefinitionLock(params.definitionId, async () => {
        let written: PipelineDefinitionSourceDocument;
        try {
          written = await writer.upsert(
            {
              definitionId: params.definitionId,
              expectedRevision: params.expectedRevision,
              name: params.name,
              description: params.description ?? '',
              icon: params.icon ?? '',
              text,
              pipeline,
            },
            context,
          );
        } catch (error) {
          throw toOperationError(error, 'The workflow could not be saved.');
        }
        const finish = async (): Promise<PipelineDefinition> => {
          const enabled = params.enabled;
          // A later write owns the enabled state once it has a newer revision.
          if (
            enabled !== undefined &&
            setEnabled &&
            (await writer.revision(written.definitionId)) ===
              written.revision &&
            (await disabledIds()).has(written.definitionId) === enabled
          )
            await setEnabled(written.definitionId, enabled);
          return definitionFrom(written, params.scope);
        };
        // The document is saved: every failure from here leaves a retry that
        // finishes enablement on it.
        const attempt = async (): Promise<PipelineDefinition> => {
          try {
            return await finish();
          } catch {
            const message =
              'The workflow was saved, but its enabled state was not.';
            throw pipelineDefinitionError(
              'core.pipeline.sourceUnavailable',
              message,
              new PipelineDefinitionResumableWrite(message, () =>
                withDefinitionLock(written.definitionId, attempt),
              ),
            );
          }
        };
        return attempt();
      });
    },

    async delete(params, signal): Promise<PipelineDefinitionDeleteResult> {
      const writer = writerFor(params.definitionId);
      let revision: number;
      try {
        revision = await writer.delete(
          params.definitionId,
          params.expectedRevision,
          { scope: {}, signal },
        );
      } catch (error) {
        throw toOperationError(error, 'The workflow could not be deleted.');
      }
      return { definitionId: params.definitionId, deleted: true, revision };
    },
  };
}
