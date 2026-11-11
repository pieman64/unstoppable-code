import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanopyDispatcher } from '@canopy/core-runtime';
import {
  CatalogMutationRuns,
  createCoreSkillCatalogHandlers,
} from '@canopy/core-runtime/node/catalog';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import {
  CORE_CATALOG_SKILL_INSTRUCTION_DEFINITIONS,
  CORE_CATALOG_SKILL_QUERY_DEFINITIONS,
  skillEntryId,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { createDesktopSkillCatalogHost } from '../../canopy-runtime/core-skill-catalog-host';
import { getDataDir } from '../../lib/paths';
import { getSkillDir } from '../../skills/paths';
import { ensureClaudeWorkspaceTrust } from '../claude-workspace-trust';

// Only host configuration and unrelated cloud/install dependencies are inert.
// Listing, path parsing, confinement, canonicalization and file reads are real.
jest.mock('../../lib/paths', () => ({ getDataDir: jest.fn() }));
jest.mock('../../skills/skill-install-context', () => ({
  assertStoredSkillContext: jest.fn(async () => {}),
}));
jest.mock('../../skills/resource-lanes', () => ({}));
jest.mock('../../canopy-cloud/shared-item-subscriptions', () => ({}));
jest.mock('../../skills/skill-discovery', () => ({}));
jest.mock('../../skills/risk', () => ({}));
jest.mock('../../skills/lock-file', () => ({}));
jest.mock('../../pipelines/config-paths', () => ({}));

function supportsCaseNeighbors(): boolean {
  const probe = mkdtempSync(path.join(tmpdir(), 'path-identity-probe-'));
  try {
    writeFileSync(path.join(probe, 'A.ts'), 'upper', { flag: 'wx' });
    try {
      writeFileSync(path.join(probe, 'a.ts'), 'lower', { flag: 'wx' });
      return true;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EEXIST'
      )
        return false;
      throw error;
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const caseTest = supportsCaseNeighbors() ? it : it.skip;
const posixTest = path.sep === '/' ? it : it.skip;
const skill = { sourceId: 'local:fixture', skillName: "雪's skill" };
const reader: CanopyCallerDescriptor = {
  principalId: 'path-identity-fixture',
  clientInstanceId: 'fixture',
  authorityId: 'fixture',
  interfaceKind: 'desktop',
  grants: ['core.catalog.read'],
};
let root: string;
let operations: OperationService;
let dispatcher: ReturnType<typeof composeDispatcher>;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- inferred from production operation definitions
function composeDispatcher() {
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: CORE_CATALOG_SKILL_QUERY_DEFINITIONS,
      instructions: CORE_CATALOG_SKILL_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      ...createCoreSkillCatalogHandlers({
        host: createDesktopSkillCatalogHost({
          refreshInventory: (): void => {},
        }),
        runs: new CatalogMutationRuns({ operations }),
      }),
      streams: {},
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'local-path-identity-'));
  jest.mocked(getDataDir).mockReturnValue(root);
  operations = new OperationService({
    openLedger: (): OperationLedger =>
      OperationLedger.open(path.join(root, 'ledger.sqlite')),
  });
  dispatcher = composeDispatcher();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

it('persists trust for the resolved workspace and preserves other configuration', async () => {
  const target = path.join(root, "Unicode 雪's workspace");
  const link = path.join(root, 'workspace-link');
  const configPath = path.join(root, 'trust-config.json');
  await mkdir(target);
  await symlink(target, link, path.sep === '\\' ? 'junction' : 'dir');
  const untouched = { hasTrustDialogAccepted: false, preserve: 'other' };
  await writeFile(
    configPath,
    JSON.stringify({
      projects: { untouched },
      preference: 42,
    }),
  );
  const canonical = await realpath(target);
  await expect(
    ensureClaudeWorkspaceTrust(link, { configPath }),
  ).resolves.toEqual({
    trustedPath: canonical,
    updated: true,
  });
  const config: unknown = JSON.parse(await readFile(configPath, 'utf8'));
  const expectedConfig = {
    hasCompletedOnboarding: true,
    preference: 42,
    projects: { untouched, [canonical]: { hasTrustDialogAccepted: true } },
  };
  expect(config).toMatchObject(expectedConfig);
  if (path.sep === '/') {
    expect(config).toEqual(expectedConfig);
  }
  const persisted = await readFile(configPath, 'utf8');
  await expect(
    ensureClaudeWorkspaceTrust(target, { configPath }),
  ).resolves.toEqual({
    trustedPath: canonical,
    updated: false,
  });
  expect(await readFile(configPath, 'utf8')).toBe(persisted);
});

caseTest(
  'trust does not grant or overwrite a distinct case-neighbor workspace',
  async () => {
    const upper = path.join(root, 'A.ts');
    const lower = path.join(root, 'a.ts');
    const configPath = path.join(root, 'trust-config.json');
    await mkdir(upper);
    await mkdir(lower);
    const link = path.join(root, 'upper-workspace-link');
    await symlink(upper, link, path.sep === '\\' ? 'junction' : 'dir');
    const canonicalUpper = await realpath(upper);
    const canonicalLower = await realpath(lower);
    const lowerEntry = { hasTrustDialogAccepted: false, preserve: 'lower' };
    await writeFile(
      configPath,
      JSON.stringify({
        projects: { [canonicalLower]: lowerEntry },
      }),
    );
    await ensureClaudeWorkspaceTrust(link, { configPath });
    const config: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config).toEqual({
      hasCompletedOnboarding: true,
      projects: {
        [canonicalLower]: lowerEntry,
        [canonicalUpper]: { hasTrustDialogAccepted: true },
      },
    });
    await expect(
      ensureClaudeWorkspaceTrust(upper, { configPath }),
    ).resolves.toEqual({ trustedPath: canonicalUpper, updated: false });
    await expect(
      ensureClaudeWorkspaceTrust(lower, { configPath }),
    ).resolves.toEqual({
      trustedPath: canonicalLower,
      updated: true,
    });
  },
);

async function seedSkill(files: string[]): Promise<string> {
  const dir = getSkillDir(skill.sourceId, skill.skillName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), '# Skill');
  for (const name of files) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), `exact:${name}`);
  }
  return dir;
}

async function expectListedFilesReadable(files: string[]): Promise<void> {
  await seedSkill(files);
  const listed = await dispatcher.query(
    'core.catalog.skill.files.list',
    { skill },
    { caller: reader },
  );
  expect(listed).toEqual({
    entryId: skillEntryId(skill),
    files: ['SKILL.md', ...files.toSorted((a, b) => a.localeCompare(b))],
    truncated: false,
  });
  for (const name of listed.files) {
    await expect(
      dispatcher.query(
        'core.catalog.skill.file.read',
        { skill, filePath: name },
        { caller: reader },
      ),
    ).resolves.toEqual({
      entryId: skillEntryId(skill),
      content: name === 'SKILL.md' ? '# Skill' : `exact:${name}`,
      truncated: false,
      binary: false,
    });
  }
}

caseTest(
  'core skill listing and reading keep case-neighbor content distinct',
  async () => {
    await expectListedFilesReadable(['A.ts', 'a.ts']);
  },
);

it('core skill listing and reading preserve Unicode, spaces and apostrophes', async () => {
  await expectListedFilesReadable(["雪's file.ts", 'two words.ts']);
});

posixTest(
  'local skill reads preserve literal backslashes and colons, including nested paths',
  async () => {
    await expectListedFilesReadable([
      'literal\\name.ts',
      'literal:name.ts',
      'docs/literal\\name.ts',
    ]);
  },
);

it('core skill reads refuse traversal, NUL and symlink escapes', async () => {
  const dir = await seedSkill(['safe.txt']);
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'must not be read');
  await symlink(
    outside,
    path.join(dir, 'escape'),
    path.sep === '\\' ? 'junction' : 'dir',
  );
  // A directory symlink works on Windows without requiring file-symlink privileges.
  const invalidPaths = [
    '../outside/secret.txt',
    '/outside/secret.txt',
    'escape/secret.txt',
  ];
  if (path.sep === '/') {
    await symlink(
      path.join(outside, 'secret.txt'),
      path.join(dir, 'literal\\escape.txt'),
    );
    invalidPaths.push('literal\\escape.txt');
  }
  for (const filePath of invalidPaths) {
    await expect(
      dispatcher.query(
        'core.catalog.skill.file.read',
        { skill, filePath },
        { caller: reader },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'core.catalog.skillPathInvalid' },
    });
  }
  await expect(
    dispatcher.query(
      'core.catalog.skill.file.read',
      { skill, filePath: 'safe.txt\0' },
      { caller: reader },
    ),
  ).rejects.toThrow();
  await expect(
    dispatcher.query(
      'core.catalog.skill.files.list',
      { skill },
      { caller: reader },
    ),
  ).resolves.toMatchObject({
    files: ['SKILL.md', 'safe.txt'],
    truncated: false,
  });
});
