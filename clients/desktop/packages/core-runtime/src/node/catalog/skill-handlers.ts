import {
  CATALOG_SKILL_UPDATES_MAX_COUNT,
  CORE_CATALOG_SKILL_CODES,
  type CORE_CATALOG_SKILL_INSTRUCTION_DEFINITIONS,
  type CORE_CATALOG_SKILL_QUERY_DEFINITIONS,
  CatalogSkillCustomSaveResultSchema,
  CatalogSkillInstallResultSchema,
  CatalogSkillRemoveResultSchema,
  CatalogSkillUpdateResultSchema,
  CatalogSkillUpdatesCheckResultSchema,
  isBoundedCanopyJsonValue,
  skillEntryId,
  type CanopyErrorKind,
  type CanopyJsonValue,
  type CanopyOperationCode,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type {
  CanopyDispatcherHandlerMap,
  CanopyDispatcherInstructionHandlerMap,
  CanopyHandlerContext,
} from '../../runtime/types';
import type {
  CatalogMutationRuns,
  CoreCatalogMutationKind,
} from './mutation-runs';
import {
  CATALOG_CUSTOM_SKILL_SOURCE_ID,
  CatalogSkillRefusedError,
  type CatalogSkillRefusal,
  type CoreSkillCatalogHost,
} from './skill-host';

export interface CatalogSkillErrorSpec {
  kind: CanopyErrorKind;
  code: CanopyOperationCode;
  message: string;
  retry: { kind: 'never' } | { kind: 'same_request' };
}

const NEVER = { kind: 'never' } as const;
const SAME_REQUEST = { kind: 'same_request' } as const;

/** Wire error per refusal: fixed Canopy-authored text (CAN-4123 D18). */
export const CATALOG_SKILL_REFUSAL_ERRORS: Readonly<
  Record<CatalogSkillRefusal, CatalogSkillErrorSpec>
> = {
  'skill-not-found': {
    kind: 'not_found',
    code: 'core.catalog.skillNotFound',
    message: 'This skill is not installed.',
    retry: NEVER,
  },
  'skill-read-only': {
    kind: 'failed_precondition',
    code: 'core.catalog.skillReadOnly',
    message: 'Built-in skills cannot be changed or removed.',
    retry: NEVER,
  },
  'skill-path-invalid': {
    kind: 'invalid_argument',
    code: 'core.catalog.skillPathInvalid',
    message: 'This skill or file path is not valid.',
    retry: NEVER,
  },
  'skill-context-refused': {
    kind: 'failed_precondition',
    code: 'core.catalog.skillContextRefused',
    message: 'This skill is not available in the current workspace context.',
    retry: NEVER,
  },
  'skill-invalid': {
    kind: 'invalid_argument',
    code: 'core.catalog.skillInvalid',
    message: "This skill's name, description or files are not valid.",
    retry: NEVER,
  },
  'skill-name-taken': {
    kind: 'already_exists',
    code: 'core.catalog.skillNameTaken',
    message: 'A skill with this name already exists.',
    retry: NEVER,
  },
  'skill-source-invalid': {
    kind: 'invalid_argument',
    code: 'core.catalog.skillSourceInvalid',
    message: 'Use a GitHub owner/repo reference or repository URL.',
    retry: NEVER,
  },
  'skills-unavailable': {
    kind: 'unavailable',
    code: 'core.catalog.skillsUnavailable',
    message: 'Skills cannot be read right now.',
    retry: SAME_REQUEST,
  },
  'skill-discovery-failed': {
    kind: 'unavailable',
    code: 'core.catalog.skillDiscoveryFailed',
    message: 'The skill source could not be read.',
    retry: SAME_REQUEST,
  },
  'skill-install-failed': {
    kind: 'unavailable',
    code: 'core.catalog.skillInstallFailed',
    message: 'The skills could not be installed.',
    retry: NEVER,
  },
  'skill-update-failed': {
    kind: 'unavailable',
    code: 'core.catalog.skillUpdateFailed',
    message: 'The skill could not be updated.',
    retry: NEVER,
  },
  'skill-remove-failed': {
    kind: 'unavailable',
    code: 'core.catalog.skillRemoveFailed',
    message: 'The skill could not be removed.',
    retry: NEVER,
  },
  'skill-save-failed': {
    kind: 'unavailable',
    code: 'core.catalog.skillSaveFailed',
    message: 'The skill could not be saved.',
    retry: NEVER,
  },
  'skill-update-check-failed': {
    kind: 'unavailable',
    code: 'core.catalog.skillUpdateCheckFailed',
    message: 'Skill updates could not be checked.',
    retry: NEVER,
  },
};

type SkillOperation = keyof typeof CORE_CATALOG_SKILL_CODES;

/** The refusal an unexpected or unlisted error becomes, per operation. */
const FAILURE_REFUSALS: Readonly<Record<SkillOperation, CatalogSkillRefusal>> =
  {
    list: 'skills-unavailable',
    read: 'skills-unavailable',
    filesList: 'skills-unavailable',
    fileRead: 'skills-unavailable',
    discover: 'skill-discovery-failed',
    install: 'skill-install-failed',
    update: 'skill-update-failed',
    remove: 'skill-remove-failed',
    customSave: 'skill-save-failed',
    updatesCheck: 'skill-update-check-failed',
  };

function errorOf(
  refusal: CatalogSkillRefusal,
  cause: unknown,
): CanopyOperationError {
  const { kind, code, message, retry } = CATALOG_SKILL_REFUSAL_ERRORS[refusal];
  return new CanopyOperationError({ kind, code, message, retry }, cause);
}

/** The typed error a host throw answers with for `operation` (CAN-4124 D12). */
function skillError(
  operation: SkillOperation,
  error: unknown,
): CanopyOperationError {
  if (!(error instanceof CatalogSkillRefusedError))
    return errorOf(FAILURE_REFUSALS[operation], error);
  const codes: readonly string[] = CORE_CATALOG_SKILL_CODES[operation];
  const refusal = codes.includes(
    CATALOG_SKILL_REFUSAL_ERRORS[error.refusal].code,
  )
    ? error.refusal
    : FAILURE_REFUSALS[operation];
  return errorOf(refusal, error.cause);
}

async function guarded<T>(
  operation: SkillOperation,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw skillError(operation, error);
  }
}

const keyReusedConflict = (): CanopyOperationError =>
  new CanopyOperationError({
    kind: 'conflict',
    message: 'This idempotency key was used with other parameters.',
    retry: NEVER,
  });

/** Install results list entry ids only as far as a ledger outcome can hold them (CAN-5873 D2). */
const INSTALL_RESULT_MAX_ENTRY_IDS = 500;

function installResult(
  sourceId: string,
  skillNames: readonly string[],
): { sourceId: string; entryIds: string[]; installedCount: number } {
  const entryIds: string[] = [];
  const result = { sourceId, entryIds, installedCount: skillNames.length };
  for (const skillName of skillNames) {
    if (entryIds.length >= INSTALL_RESULT_MAX_ENTRY_IDS) break;
    entryIds.push(skillEntryId({ sourceId, skillName }));
    if (!isBoundedCanopyJsonValue(result)) {
      entryIds.pop();
      break;
    }
  }
  return result;
}

type UpdatesCheckRow = {
  sourceId: string;
  skillName: string;
  updateAvailable: boolean;
};

/**
 * The compact update-check result (CAN-5898): counts for every checked skill,
 * and the skills with an update only as far as a ledger outcome can hold
 * them. The full map stays with the skill service.
 */
function updatesCheckResult(rows: readonly UpdatesCheckRow[]): {
  updates: (UpdatesCheckRow & { entryId: string })[];
  checkedCount: number;
  updateCount: number;
} {
  const available = rows.filter((row) => row.updateAvailable);
  const updates: (UpdatesCheckRow & { entryId: string })[] = [];
  const result = {
    updates,
    checkedCount: Math.min(rows.length, CATALOG_SKILL_UPDATES_MAX_COUNT),
    updateCount: Math.min(available.length, CATALOG_SKILL_UPDATES_MAX_COUNT),
  };
  for (const row of available) {
    updates.push({ entryId: skillEntryId(row), ...row });
    if (!isBoundedCanopyJsonValue(result)) {
      updates.pop();
      break;
    }
  }
  return result;
}

const decodeWith =
  <Result extends CanopyJsonValue>(schema: {
    safeParse: (value: unknown) => { data?: Result };
  }) =>
  (outcome: unknown): Result | null =>
    schema.safeParse(outcome).data ?? null;

export interface CoreSkillCatalogHandlers {
  queries: CanopyDispatcherHandlerMap<
    typeof CORE_CATALOG_SKILL_QUERY_DEFINITIONS
  >;
  instructions: CanopyDispatcherInstructionHandlerMap<
    typeof CORE_CATALOG_SKILL_INSTRUCTION_DEFINITIONS
  >;
}

export function createCoreSkillCatalogHandlers(options: {
  host: CoreSkillCatalogHost;
  runs: CatalogMutationRuns;
}): CoreSkillCatalogHandlers {
  const { host, runs } = options;

  const keyed = <Result extends CanopyJsonValue>(request: {
    kind: CoreCatalogMutationKind;
    operation: SkillOperation;
    context: CanopyHandlerContext;
    params: { _meta: { idempotencyKey: string } } & Record<string, unknown>;
    decode: (outcome: unknown) => Result | null;
    effect: () => Promise<Result>;
  }): Promise<Result> =>
    runs.run({
      kind: request.kind,
      context: request.context,
      params: request.params,
      codes: CORE_CATALOG_SKILL_CODES[request.operation],
      keyReused: keyReusedConflict,
      decode: request.decode,
      effect: () => guarded(request.operation, request.effect),
    });

  return {
    queries: {
      'core.catalog.skill.list': async () => ({
        skills: await guarded('list', () => host.list()),
      }),
      'core.catalog.skill.read': async (params) => ({
        entryId: skillEntryId(params.skill),
        ...(await guarded('read', () => host.read(params.skill))),
      }),
      'core.catalog.skill.files.list': async (params) => ({
        entryId: skillEntryId(params.skill),
        ...(await guarded('filesList', () => host.listFiles(params.skill))),
      }),
      'core.catalog.skill.file.read': async (params) => ({
        entryId: skillEntryId(params.skill),
        ...(await guarded('fileRead', () =>
          host.readFile(params.skill, params.filePath),
        )),
      }),
      'core.catalog.skill.discover': (params) =>
        guarded('discover', () => host.discover(params.source)),
    },
    instructions: {
      'core.catalog.skill.install': (params, context) =>
        keyed({
          kind: 'core.catalog.skill.install',
          operation: 'install',
          context,
          params,
          decode: decodeWith(CatalogSkillInstallResultSchema),
          effect: async () => {
            const { sourceId, skillNames } = await host.install({
              source: params.source,
              skillNames: params.skillNames,
            });
            return installResult(sourceId, skillNames);
          },
        }),
      'core.catalog.skill.update': (params, context) =>
        keyed({
          kind: 'core.catalog.skill.update',
          operation: 'update',
          context,
          params,
          decode: decodeWith(CatalogSkillUpdateResultSchema),
          effect: async () => {
            await host.update(params.skill);
            return { entryId: skillEntryId(params.skill) };
          },
        }),
      'core.catalog.skill.remove': (params, context) =>
        keyed({
          kind: 'core.catalog.skill.remove',
          operation: 'remove',
          context,
          params,
          decode: decodeWith(CatalogSkillRemoveResultSchema),
          effect: async () => {
            await host.remove(params.skill);
            return { entryId: skillEntryId(params.skill) };
          },
        }),
      'core.catalog.skill.custom.save': (params, context) =>
        keyed({
          kind: 'core.catalog.skill.custom.save',
          operation: 'customSave',
          context,
          params,
          decode: decodeWith(CatalogSkillCustomSaveResultSchema),
          effect: async () => {
            const { skillName } = await host.saveCustom({
              name: params.name,
              originalName: params.originalName,
              description: params.description,
              body: params.body,
              extraMetadata: params.extraMetadata,
              preservedMetadata: params.preservedMetadata,
              files: params.files,
            });
            return {
              entryId: skillEntryId({
                sourceId: CATALOG_CUSTOM_SKILL_SOURCE_ID,
                skillName,
              }),
              skillName,
            };
          },
        }),
      'core.catalog.skill.updates.check': (params, context) =>
        keyed({
          kind: 'core.catalog.skill.updates.check',
          operation: 'updatesCheck',
          context,
          params,
          decode: decodeWith(CatalogSkillUpdatesCheckResultSchema),
          effect: async () => updatesCheckResult(await host.checkUpdates()),
        }),
    },
  };
}
