import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORE_CATALOG_SKILL_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_SKILL_QUERY_DEFINITIONS,
  CatalogSkillInstallResultSchema,
  isBoundedCanopyJsonValue,
  type CanopyCallerDescriptor,
  type CatalogSkillDiscoverResult,
  type CatalogSkillRow,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../../../runtime/dispatcher';
import { OperationService } from '../../operations';
import { OperationLedger } from '../../operations/ledger';
import {
  CatalogMutationRuns,
  CatalogSkillRefusedError,
  createCoreSkillCatalogHandlers,
  type CatalogSkillCustomSaveRequest,
  type CoreSkillCatalogHost,
} from '..';

class MemorySkillHost implements CoreSkillCatalogHost {
  readonly calls = {
    install: 0,
    update: 0,
    remove: 0,
    read: 0,
  };
  installError: Error | null = null;
  updateError: Error | null = null;
  removeError: Error | null = null;

  list(): Promise<CatalogSkillRow[]> {
    return Promise.resolve([]);
  }

  read(): Promise<{
    frontmatter: Record<string, string>;
    body: string;
    truncated: boolean;
  }> {
    this.calls.read += 1;
    return Promise.resolve({
      frontmatter: { name: 'n' },
      body: 'b',
      truncated: false,
    });
  }

  listFiles(): Promise<{ files: string[]; truncated: boolean }> {
    return Promise.resolve({ files: ['SKILL.md'], truncated: false });
  }

  readFile(): Promise<{
    content: string;
    truncated: boolean;
    binary: boolean;
  }> {
    return Promise.resolve({ content: '', truncated: false, binary: false });
  }

  discover(source: string): Promise<CatalogSkillDiscoverResult> {
    return Promise.resolve({
      source,
      skills: [],
      riskInfo: {},
      hasMarketplace: false,
      truncated: false,
    });
  }

  install(request: {
    source: string;
    skillNames: readonly string[];
  }): Promise<{ sourceId: string; skillNames: string[] }> {
    this.calls.install += 1;
    if (this.installError) return Promise.reject(this.installError);
    return Promise.resolve({
      sourceId: 'github:o:r',
      skillNames: [...request.skillNames],
    });
  }

  update(): Promise<void> {
    this.calls.update += 1;
    if (this.updateError) return Promise.reject(this.updateError);
    return Promise.resolve();
  }

  remove(): Promise<void> {
    this.calls.remove += 1;
    if (this.removeError) return Promise.reject(this.removeError);
    return Promise.resolve();
  }

  saveCustom(
    request: CatalogSkillCustomSaveRequest,
  ): Promise<{ skillName: string }> {
    return Promise.resolve({ skillName: request.name });
  }

  checkUpdates(): Promise<
    { sourceId: string; skillName: string; updateAvailable: boolean }[]
  > {
    return Promise.resolve([]);
  }
}

const caller = (
  grant: CanopyCallerDescriptor['grants'][number],
): CanopyCallerDescriptor => ({
  principalId: 'p',
  clientInstanceId: 'c',
  authorityId: 'a',
  interfaceKind: 'desktop',
  grants: [grant],
});
const reader = caller('core.catalog.read');
const writer = caller('core.catalog.write');
const keyed = (key: string): { idempotencyKey: string } => ({
  idempotencyKey: key,
});
const skill = { sourceId: 'github:o:r', skillName: 'n' };

let root: string;
let ledgerPath: string;
let host: MemorySkillHost;
const services: OperationService[] = [];

function openOperations(): OperationService {
  const operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  services.push(operations);
  return operations;
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the dispatcher type is inferred from its definitions
function compose(operations: OperationService) {
  const runs = new CatalogMutationRuns({ operations });
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: CORE_CATALOG_SKILL_QUERY_DEFINITIONS,
      instructions: CORE_CATALOG_SKILL_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      ...createCoreSkillCatalogHandlers({ host, runs }),
      streams: {},
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-4124-'));
  ledgerPath = join(root, 'ledger.sqlite');
  host = new MemorySkillHost();
});
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  rmSync(root, { recursive: true, force: true });
});

describe('core.catalog.skill handlers (CAN-4124)', () => {
  it('runs each skill change once per key, across a restart', async () => {
    const first = openOperations();
    const dispatcher = compose(first);
    const install = (): Promise<unknown> =>
      dispatcher.instruction(
        'core.catalog.skill.install',
        { source: 'o/r', skillNames: ['n'], _meta: keyed('k') },
        { caller: writer, metadata: keyed('k') },
      );
    const [a, b] = await Promise.all([install(), install()]);
    expect(a).toEqual({
      sourceId: 'github:o:r',
      entryIds: ['skill:github:o:r/n'],
      installedCount: 1,
    });
    expect(b).toEqual(a);
    expect(host.calls.install).toBe(1);

    first.close();
    const after = compose(openOperations());
    await expect(
      after.instruction(
        'core.catalog.skill.install',
        { source: 'o/r', skillNames: ['n'], _meta: keyed('k') },
        { caller: writer, metadata: keyed('k') },
      ),
    ).resolves.toEqual(a);
    expect(host.calls.install).toBe(1);
  });

  it('records a 600-skill install with a receipt that fits the ledger (CAN-5873)', async () => {
    const names = Array.from(
      { length: 600 },
      (_, index) =>
        `a-skill-with-a-long-descriptive-name-from-a-large-source-${index}`,
    );
    const first = openOperations();
    const install = (
      dispatcher: ReturnType<typeof compose>,
    ): Promise<unknown> =>
      dispatcher.instruction(
        'core.catalog.skill.install',
        { source: 'o/r', skillNames: names, _meta: keyed('big') },
        { caller: writer, metadata: keyed('big') },
      );
    const result = await install(compose(first));
    expect(result).toMatchObject({
      sourceId: 'github:o:r',
      installedCount: 600,
    });
    const { entryIds } = CatalogSkillInstallResultSchema.parse(result);
    expect(entryIds.length).toBeGreaterThan(0);
    expect(entryIds.length).toBeLessThan(600);
    expect(entryIds).toEqual(
      names.slice(0, entryIds.length).map((name) => `skill:github:o:r/${name}`),
    );
    expect(isBoundedCanopyJsonValue(result)).toBe(true);

    first.close();
    await expect(install(compose(openOperations()))).resolves.toEqual(result);
    expect(host.calls.install).toBe(1);
  });

  it('answers refusals with fixed text and keeps the host error as the cause', async () => {
    const dispatcher = compose(openOperations());
    const cause = new Error('Built-in skills cannot be removed.');
    host.removeError = new CatalogSkillRefusedError('skill-read-only', cause);
    const remove = (): Promise<unknown> =>
      dispatcher.instruction(
        'core.catalog.skill.remove',
        { skill, _meta: keyed('k') },
        { caller: writer, metadata: keyed('k') },
      );
    const payload = {
      kind: 'failed_precondition',
      code: 'core.catalog.skillReadOnly',
      message: 'Built-in skills cannot be changed or removed.',
    };
    const first: unknown = await remove().catch((error: unknown) => error);
    expect(first).toMatchObject({ payload, runtimeCause: cause });
    const replay: unknown = await remove().catch((error: unknown) => error);
    expect(replay).toMatchObject({ payload });
    expect(replay).toHaveProperty('runtimeCause', undefined);
    expect(host.calls.remove).toBe(1);
  });

  it("an unexpected error gets the operation's failure code", async () => {
    const dispatcher = compose(openOperations());
    const boom = new Error('boom');
    host.updateError = boom;
    const error: unknown = await dispatcher
      .instruction(
        'core.catalog.skill.update',
        { skill, _meta: keyed('k') },
        { caller: writer, metadata: keyed('k') },
      )
      .catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({
      payload: { kind: 'unavailable', code: 'core.catalog.skillUpdateFailed' },
      runtimeCause: boom,
    });
  });

  it("a refusal outside an operation's codes gets its failure code", async () => {
    const dispatcher = compose(openOperations());
    host.installError = new CatalogSkillRefusedError('skill-read-only');
    await expect(
      dispatcher.instruction(
        'core.catalog.skill.install',
        { source: 'o/r', skillNames: ['n'], _meta: keyed('k') },
        { caller: writer, metadata: keyed('k') },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.catalog.skillInstallFailed' },
    });
  });

  it('reads answer with entry ids and never use the ledger', async () => {
    const operations = openOperations();
    const dispatcher = compose(operations);
    await expect(
      dispatcher.query(
        'core.catalog.skill.read',
        { skill: { sourceId: 'github:o:r', skillName: 'n' } },
        { caller: reader },
      ),
    ).resolves.toMatchObject({ entryId: 'skill:github:o:r/n' });
    expect((await operations.ready()).list({ limit: 10 }).items).toEqual([]);
  });

  it('refuses calls without their grant', async () => {
    const dispatcher = compose(openOperations());
    await expect(
      dispatcher.query(
        'core.catalog.skill.read',
        { skill },
        { caller: writer },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    await expect(
      dispatcher.instruction(
        'core.catalog.skill.remove',
        { skill, _meta: keyed('k') },
        { caller: reader, metadata: keyed('k') },
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(host.calls.read).toBe(0);
    expect(host.calls.remove).toBe(0);
  });
});
