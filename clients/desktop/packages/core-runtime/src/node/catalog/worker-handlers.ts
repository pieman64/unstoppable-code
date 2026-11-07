import type {
  WORKER_CATALOG_INSTRUCTION_DEFINITIONS,
  WORKER_CATALOG_QUERY_DEFINITIONS,
  CanopyErrorKind,
  CanopyOperationCode,
  CanopyRetryDirective,
  WorkerCatalogMaterialization,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../runtime/errors';
import type {
  CanopyDispatcherHandlerMap,
  CanopyDispatcherInstructionHandlerMap,
  CanopyDispatcherInstructionParams,
} from '../../runtime/types';
import { catalogMaterializationIdentity } from './revision';

/*
 * `worker.catalog.*` on the in-process worker (CAN-4123): materializations
 * are in-memory records under their content-addressed id. A ready or failed
 * record is never rewritten; only a released one materializes again.
 */

export interface WorkerCatalogPluginInstall {
  pluginRevision: string;
  roots: {
    claude: string | null;
    codex: { root: string; mode: 'native' | 'compat' } | null;
  };
}

export interface WorkerCatalogSkillInstall {
  skillRevision: string;
  /** Lexically contained directory (Claude and Codex sessions read it in place). */
  sourceDir: string;
  /** Realpath-contained directory, or null when it escapes (Cursor, Copilot and OpenCode sessions copy from it). */
  canonicalSourceDir: string | null;
  skillMdPath: string;
}

/** The worker's view of installed plugins; host-local, never on the wire. */
export interface WorkerCatalogHost {
  lookupPlugin(
    marketplaceId: string,
    pluginName: string,
  ): Promise<WorkerCatalogPluginInstall | null>;
  /** CAN-4124. */
  lookupSkill(
    sourceId: string,
    skillName: string,
  ): Promise<WorkerCatalogSkillInstall | null>;
}

/** Worker-local handoff (CAN-4115 reads it at session start). Paths never cross the wire. */
export interface WorkerCatalogMaterializedBundle {
  materializationId: string;
  fingerprint: string;
  plugins: readonly {
    entryId: string;
    marketplaceId: string;
    pluginName: string;
    roots: {
      claude?: string;
      codex?: { root: string; mode: 'native' | 'compat' };
    };
  }[];
  /** CAN-4124. */
  skills: readonly {
    entryId: string;
    sourceId: string;
    skillName: string;
    sourceDir: string;
    canonicalSourceDir: string | null;
    skillMdPath: string;
  }[];
}

export interface WorkerCatalogMaterializationReader {
  /** A ready materialization's pinned roots; null when unknown, failed or released. */
  resolve(materializationId: string): WorkerCatalogMaterializedBundle | null;
}

export interface WorkerCatalogHandlers {
  queries: CanopyDispatcherHandlerMap<typeof WORKER_CATALOG_QUERY_DEFINITIONS>;
  instructions: CanopyDispatcherInstructionHandlerMap<
    typeof WORKER_CATALOG_INSTRUCTION_DEFINITIONS
  >;
  reader: WorkerCatalogMaterializationReader;
}

interface MaterializationRecord {
  materialization: WorkerCatalogMaterialization;
  bundle: WorkerCatalogMaterializedBundle | null;
  /** A failed record's refusal, repeated to every later attempt. */
  error: CanopyOperationError | null;
}

type WorkerCatalogMaterializeParams = CanopyDispatcherInstructionParams<
  typeof WORKER_CATALOG_INSTRUCTION_DEFINITIONS,
  'worker.catalog.materialize'
>;
type Diagnostic = WorkerCatalogMaterialization['diagnostics'][number];
type EffectiveItem = WorkerCatalogMaterialization['effectiveItems'][number];
type BundlePlugin = WorkerCatalogMaterializedBundle['plugins'][number];
type BundleSkill = WorkerCatalogMaterializedBundle['skills'][number];

const DEFAULT_MAX_RECORDS = 256;
const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex' } as const;

function fail(
  kind: CanopyErrorKind,
  message: string,
  options: { code?: CanopyOperationCode; retry?: CanopyRetryDirective } = {},
): CanopyOperationError {
  return new CanopyOperationError({
    kind,
    message,
    retry: options.retry ?? { kind: 'never' },
    ...(options.code !== undefined ? { code: options.code } : {}),
  });
}

const notFound = (): CanopyOperationError =>
  fail('not_found', 'This materialization is not on this worker.', {
    code: 'worker.catalog.materialization.notFound',
  });

const byEntryId = (a: { entryId: string }, b: { entryId: string }): number =>
  a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;

export function createWorkerCatalogHandlers(options: {
  host: WorkerCatalogHost;
  maxRecords?: number;
}): WorkerCatalogHandlers {
  const { host } = options;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const records = new Map<string, MaterializationRecord>();
  const running = new Map<string, Promise<WorkerCatalogMaterialization>>();

  // Ready records go last: sessions read them through the reader.
  const oldestIn = (
    state: WorkerCatalogMaterialization['state'],
  ): string | undefined => {
    for (const [key, value] of records)
      if (value.materialization.state === state) return key;
    return undefined;
  };

  const store = (id: string, record: MaterializationRecord): void => {
    records.delete(id);
    records.set(id, record);
    while (records.size > maxRecords) {
      const evict =
        oldestIn('released') ??
        oldestIn('failed') ??
        records.keys().next().value;
      if (evict === undefined) break;
      records.delete(evict);
    }
  };

  const materialize = async (
    params: WorkerCatalogMaterializeParams,
  ): Promise<WorkerCatalogMaterialization> => {
    const { materializationId, expectedFingerprint: fingerprint } = params;
    const diagnostics: Diagnostic[] = [];
    const effectiveItems: EffectiveItem[] = [];
    const plugins: BundlePlugin[] = [];
    const skills: BundleSkill[] = [];
    const failSkillRevision = (): never => {
      const error = fail(
        'conflict',
        'The skill changed since this materialization was resolved.',
        {
          code: 'worker.catalog.revisionConflict',
          retry: { kind: 'after_refresh', resource: 'core.catalog.snapshot' },
        },
      );
      store(materializationId, {
        materialization: {
          materializationId,
          state: 'failed',
          fingerprint,
          effectiveItems: [],
          diagnostics: [],
        },
        bundle: null,
        error,
      });
      throw error;
    };
    for (const descriptor of params.itemDescriptors) {
      if (descriptor.kind === 'skill') {
        const { entryId, sourceId, skillName } = descriptor;
        let install: WorkerCatalogSkillInstall | null;
        try {
          install = await host.lookupSkill(sourceId, skillName);
        } catch {
          throw fail(
            'unavailable',
            'The plugin catalog cannot be read right now.',
            {
              retry: { kind: 'same_idempotency_key' },
            },
          );
        }
        if (install === null) {
          diagnostics.push({
            entryId,
            code: 'worker.catalog.itemMissing',
            severity: 'error',
            message: 'This skill is not installed on this device.',
          });
          continue;
        }
        if (install.skillRevision !== descriptor.skillRevision)
          failSkillRevision();
        effectiveItems.push({ entryId, kind: 'skill' });
        skills.push({
          entryId,
          sourceId,
          skillName,
          sourceDir: install.sourceDir,
          canonicalSourceDir: install.canonicalSourceDir,
          skillMdPath: install.skillMdPath,
        });
        continue;
      }
      if (descriptor.kind !== 'plugin') continue;
      const { entryId, marketplaceId, pluginName } = descriptor;
      let install: WorkerCatalogPluginInstall | null;
      try {
        install = await host.lookupPlugin(marketplaceId, pluginName);
      } catch {
        throw fail(
          'unavailable',
          'The plugin catalog cannot be read right now.',
          {
            retry: { kind: 'same_idempotency_key' },
          },
        );
      }
      if (install === null) {
        diagnostics.push({
          entryId,
          code: 'worker.catalog.itemMissing',
          severity: 'error',
          message: 'This plugin is not installed on this device.',
        });
        continue;
      }
      if (install.pluginRevision !== descriptor.pluginRevision) {
        const error = fail(
          'conflict',
          'The plugin catalog changed since this materialization was resolved.',
          {
            code: 'worker.catalog.revisionConflict',
            retry: { kind: 'after_refresh', resource: 'core.catalog.snapshot' },
          },
        );
        store(materializationId, {
          materialization: {
            materializationId,
            state: 'failed',
            fingerprint,
            effectiveItems: [],
            diagnostics: [],
          },
          bundle: null,
          error,
        });
        throw error;
      }
      const providers: ('claude' | 'codex')[] = [];
      const roots: BundlePlugin['roots'] = {};
      for (const provider of descriptor.providers) {
        if (provider === 'claude' && install.roots.claude !== null) {
          providers.push(provider);
          roots.claude = install.roots.claude;
          continue;
        }
        if (provider === 'codex' && install.roots.codex !== null) {
          providers.push(provider);
          roots.codex = { ...install.roots.codex };
          continue;
        }
        diagnostics.push({
          entryId,
          code: 'worker.catalog.providerMissing',
          severity: 'warning',
          message: `This plugin is not installed for ${PROVIDER_NAMES[provider]}.`,
        });
      }
      if (providers.length === 0) continue;
      effectiveItems.push({ entryId, kind: 'plugin', providers });
      plugins.push({ entryId, marketplaceId, pluginName, roots });
    }
    const materialization: WorkerCatalogMaterialization = {
      materializationId,
      state: 'ready',
      fingerprint,
      effectiveItems: effectiveItems.sort(byEntryId),
      diagnostics,
    };
    store(materializationId, {
      materialization,
      bundle: {
        materializationId,
        fingerprint,
        plugins: plugins.sort(byEntryId),
        skills: skills.sort(byEntryId),
      },
      error: null,
    });
    return materialization;
  };

  return {
    queries: {
      'worker.catalog.materialization.get': (params) => {
        const record = records.get(params.materializationId);
        if (!record) throw notFound();
        return record.materialization;
      },
    },
    instructions: {
      'worker.catalog.materialize': async (params) => {
        if ((params.secretGrantIds ?? []).length > 0)
          throw fail(
            'capability_unavailable',
            'This worker does not take MCP secrets yet.',
          );
        if (params.itemDescriptors.some((item) => item.kind === 'mcp_server'))
          throw fail(
            'capability_unavailable',
            'This worker does not materialize MCP servers yet.',
          );
        const identity = catalogMaterializationIdentity(
          params.itemDescriptors,
          params.scope,
        );
        if (
          identity.fingerprint !== params.expectedFingerprint ||
          identity.materializationId !== params.materializationId
        )
          throw fail(
            'invalid_argument',
            'These items do not match their materialization identity.',
            { code: 'worker.catalog.invalidState' },
          );
        const id = params.materializationId;
        const existing = records.get(id);
        if (existing?.error)
          throw new CanopyOperationError(existing.error.payload);
        if (existing && existing.materialization.state !== 'released') {
          store(id, existing);
          return existing.materialization;
        }
        const joined = running.get(id);
        if (joined) return joined;
        const attempt = materialize(params);
        running.set(id, attempt);
        try {
          return await attempt;
        } finally {
          running.delete(id);
        }
      },
      'worker.catalog.materialization.release': (params) => {
        const record = records.get(params.materializationId);
        if (!record) throw notFound();
        if (record.materialization.state !== 'released')
          records.set(params.materializationId, {
            materialization: { ...record.materialization, state: 'released' },
            bundle: null,
            error: null,
          });
        return { released: true };
      },
    },
    reader: {
      resolve: (materializationId) => {
        const record = records.get(materializationId);
        return record?.materialization.state === 'ready' ? record.bundle : null;
      },
    },
  };
}
