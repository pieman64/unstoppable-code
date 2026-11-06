import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { ExecutionSecretGrants } from '@canopy/core-runtime/node/execution-secrets';
import type { ExecutionSecretBinding } from '@canopy/protocol/canopy-core';
import {
  createDefaultEnvironmentConfig,
  resolveEnvironmentForRuntime,
  resolveEnvironmentSecretSlots,
} from '@canopy/desktop-shared/lib/user-environment';
import type { EnvironmentConfigData } from '@canopy/desktop-shared/types/user-environment';

jest.mock('../../lib/user-environment-store', () => ({
  readEnvironmentConfig: jest.fn(),
}));
jest.mock('../../lib/github-pat-env', () => ({
  readGitHubPatForExecution: jest.fn(),
}));
jest.mock('../../lib/linear-auth', () => ({ resolveLinearToken: jest.fn() }));
jest.mock('../../shared-containers/run-env-store', () => ({
  readSharedContainerRunEnvironment: jest.fn(),
}));

import { readEnvironmentConfig } from '../../lib/user-environment-store';
import { readGitHubPatForExecution } from '../../lib/github-pat-env';
import { storedSecretRef } from '../../lib/stored-secrets';
import { environmentSecretSlot } from '../../lib/environment-secret-view';
import { desktopExecutionSecretReader } from '../reader';
import { buildScriptSecretBindings } from '../bindings';

let config: EnvironmentConfigData;
beforeEach(() => {
  jest.clearAllMocks();
  const now = '2026-11-05T00:00:00.000Z';
  config = createDefaultEnvironmentConfig(now);
  const parent = {
    id: 'parent',
    name: 'Parent',
    parentId: null,
    isDefault: false,
    uiMode: 'key-value' as const,
    createdAt: now,
    updatedAt: now,
    variables: [
      { key: 'SECRET', value: 'parent', secret: true },
      { key: 'HIDDEN', value: 'secret', secret: true },
      { key: 'GH_TOKEN', value: 'env-pat', secret: true },
      { key: '__proto__', value: 'ignored-by-existing-resolver', secret: true },
    ],
  };
  const leaf = {
    ...parent,
    id: 'leaf',
    name: 'Leaf',
    parentId: 'parent',
    variables: [
      { key: 'SECRET', value: 'child', secret: true },
      { key: 'HIDDEN', value: 'public', secret: false },
      { key: 'EMPTY', value: '', secret: true },
      { key: 'PATH', value: 'reserved', secret: true },
    ],
  };
  config.environments.push(parent, leaf);
  config.globalRuntimes.canopy = 'parent';
  config.workspaceAssignments.push({
    workspaceId: 'workspace',
    runtimes: { canopy: 'leaf', agent: null, pipeline: null },
    updatedAt: now,
  });
  jest
    .mocked(readEnvironmentConfig)
    .mockImplementation(() =>
      Promise.resolve({ data: config, encryptionAvailable: true }),
    );
  jest.mocked(readGitHubPatForExecution).mockReturnValue(null);
});

it('binds exactly the secret entries the canopy runtime applies', () => {
  for (const request of [
    { runtime: 'canopy' as const },
    { runtime: 'canopy' as const, workspaceId: 'workspace' },
  ]) {
    const slots = resolveEnvironmentSecretSlots(config, request);
    expect(slots.map((slot) => slot.key).sort()).toEqual(
      Object.keys(
        resolveEnvironmentForRuntime(config, request).secretApplied,
      ).sort(),
    );
    expect(slots.find((slot) => slot.key === 'SECRET')?.environmentId).toBe(
      request.workspaceId ? 'leaf' : 'parent',
    );
    expect(slots.some((slot) => slot.key === 'PATH')).toBe(false);
  }
});
it('reads empty secrets as empty strings', async () => {
  const bindings = await buildScriptSecretBindings({
    context: { kind: 'project' },
    workspaceId: 'workspace',
    worktreeId: 'worktree',
  });
  const grants = new ExecutionSecretGrants({
    reader: desktopExecutionSecretReader,
  });
  const audience = { operation: 'worker.script.execute' as const, key: 'run' };
  grants.stage(audience, bindings);
  expect(
    (await grants.redeem({ audience, bindings }, new AbortController().signal))
      .env.EMPTY,
  ).toBe('');
});
it('a renamed key or deleted environment reads as missing', async () => {
  const binding: ExecutionSecretBinding = {
    name: 'SECRET',
    source: {
      kind: 'stored-secret',
      family: 'environment',
      record: 'config',
      ref: storedSecretRef(
        'environment',
        'config',
        environmentSecretSlot('leaf', 'SECRET'),
      ),
    },
  };
  const leaf = config.environments.find(
    (environment) => environment.id === 'leaf',
  );
  if (!leaf) throw new Error('Missing fixture');
  leaf.variables = leaf.variables.map((entry) => ({
    ...entry,
    key: entry.key === 'SECRET' ? 'RENAMED' : entry.key,
  }));
  expect(
    await desktopExecutionSecretReader.read(
      [binding],
      new AbortController().signal,
    ),
  ).toEqual([{ status: 'missing' }]);
  config.environments = config.environments.filter(
    (environment) => environment.id !== 'leaf',
  );
  expect(
    await desktopExecutionSecretReader.read(
      [binding],
      new AbortController().signal,
    ),
  ).toEqual([{ status: 'missing' }]);
});
it('the PAT binding wins over an environment GH_TOKEN for scripts', async () => {
  jest.mocked(readGitHubPatForExecution).mockReturnValue('pat');
  const bindings = await buildScriptSecretBindings({
    context: { kind: 'project' },
    workspaceId: 'workspace',
    worktreeId: 'worktree',
  });
  expect(bindings.filter((binding) => binding.name === 'GH_TOKEN')).toEqual([
    {
      name: 'GH_TOKEN',
      source: { kind: 'integration-token', provider: 'github-pat' },
    },
  ]);
});
it('the worker host modules import no secret store', () => {
  const forbidden = [
    '/user-environment-store',
    '/linear-auth',
    '/github-pat-env',
    '/run-env-store',
    '/stored-secrets',
  ];
  for (const name of [
    'lib/script-execution-place.ts',
    'pipelines/pipeline-worker-host.ts',
  ]) {
    const path = resolve(__dirname, '../..', name);
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const imports: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) imports.push(arg.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(
      imports.filter((specifier) =>
        forbidden.some((suffix) => specifier.endsWith(suffix)),
      ),
    ).toEqual([]);
  }
});
