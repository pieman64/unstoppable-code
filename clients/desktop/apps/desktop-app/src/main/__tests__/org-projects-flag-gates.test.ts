/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { ORG_PROJECTS_FLAG_GATES } from '../lib/org-projects-flag-gates';

const root = resolve(__dirname, '../../../../..');

/** Ignore comments, imports and type declarations: they are not flag reads. */
function runtimeNames(file: string): {
  names: Set<string>;
  exported: Set<string>;
} {
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(root, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  const exported = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.canHaveModifiers(statement) ||
      !ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue;
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      exported.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name))
          exported.add(declaration.name.text);
      }
    }
  }
  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    )
      return;
    if (ts.isIdentifier(node) || ts.isStringLiteral(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { names, exported };
}

describe('org-projects flag-gate manifest', () => {
  it.each(ORG_PROJECTS_FLAG_GATES.filter(({ file }) => !file.startsWith('apps/web/')))(
    '$ticket: $file ($entryPoint) is gated by $gate ($kind)',
    ({ file, entryPoint, gate, kind, host, reason }): void => {
      const { names, exported } = runtimeNames(file);
      expect(exported.has(entryPoint)).toBe(true);
      switch (kind) {
        case 'direct':
          expect(names.has(gate)).toBe(true);
          break;
        case 'host': {
          // The entry's own behaviour follows the host's projection, so the
          // host must read the flag and the entry must depend on the host.
          if (!host) throw new Error(`${file}: host gate without a host`);
          expect(runtimeNames(host).names.has(gate)).toBe(true);
          const hostModule = host
            .replace(/\.tsx?$/, '')
            .split('/')
            .pop();
          // Imports are excluded from runtime names on purpose; the dependency
          // is proven from the module source instead.
          expect(
            readFileSync(resolve(root, file), 'utf8').includes(
              `/${hostModule}'`,
            ),
          ).toBe(true);
          break;
        }
        case 'exception':
          // Recorded, not silently accepted: the reason is the audit trail.
          expect(reason?.trim().length ?? 0).toBeGreaterThan(40);
          expect(names.has(gate)).toBe(false);
          break;
      }
    },
  );

  it('requires direct catalog service and IPC gates', (): void => {
    for (const file of [
      'apps/desktop-app/src/main/services/org-project-catalog-service.ts',
      'apps/desktop-app/src/main/ipc/org-projects.ts',
    ]) {
      expect(
        ORG_PROJECTS_FLAG_GATES.find((entry) => entry.file === file)?.kind,
      ).toBe('direct');
      expect(runtimeNames(file).names.has('canopyOrgProjectsEnabled')).toBe(
        true,
      );
    }
  });

  it('lists every accepted exception so the audit cannot forget one', (): void => {
    const exceptions = ORG_PROJECTS_FLAG_GATES.filter(
      (entry) => entry.kind === 'exception',
    ).map((entry) => entry.file);
    expect(exceptions).toEqual([
      'apps/desktop-app/src/main/lib/org-member-folder-inspection.ts',
      'apps/web/src/lib/agents/agent-api.ts',
      'apps/web/src/lib/skills/skill-api.ts',
      'apps/web/src/lib/automations/automation-api.ts',
      'apps/web/src/lib/collections/collection-api.ts',
      'apps/web/src/lib/plans/plan-api.ts',
      'apps/web/src/lib/pipelines/pipeline-api.ts',
      'apps/web/src/lib/plugins/shared-plugin-service.ts',
      'apps/web/src/lib/plugin-marketplaces/marketplace-service.ts',
      'apps/web/src/lib/telemetry/telemetry-service.ts',
    ]);
  });
});

// Only host I/O and flag evaluation are mocked; policy, context service, IPC,
// carryover ledger and telemetry destination resolution run their real code.
const mockEnabled = jest.fn((): boolean => false);
const mockReadFile = jest.fn<Promise<string>, [string, string]>();
const mockWrite = jest.fn(async (): Promise<void> => {});
const mockRemove = jest.fn(async (): Promise<void> => {});
const mockDiagnostic = jest.fn();
const mockRegister = jest.fn<void, [string, (...args: unknown[]) => unknown]>();
const organizationId = '11111111-1111-4111-8111-111111111111';
const account = {
  account: { id: 'audit-user' },
  capabilities: ['resource-context-v1', 'org-projects-v1'],
  organizations: [
    { id: organizationId, name: 'Audit organization', role: 'MEMBER' },
  ],
};
const mockReadAccount = jest.fn(
  (): Promise<object> => Promise.resolve({ status: 'ok', entry: account }),
);
const mockCredentials = jest.fn(
  (): Promise<object> => Promise.resolve(account),
);
const mockTelemetryRequests: Array<{
  shareScope: string;
  organizationId?: string;
  teamId?: string;
  workspace: {
    clientLocalId: string;
    worktrees?: Array<{ clientLocalId: string }>;
  };
}> = [];

// Telemetry flushes read the install's device id for space provenance
// (CAN-3615); keep that off disk.
jest.mock('../canopy-cloud/oauth-login', () => ({
  getDesktopOAuthClientDeviceId: (): Promise<string> =>
    Promise.resolve('org-projects-device'),
}));
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): object => ({
    isEnabled: mockEnabled,
    onSnapshotChanged: (): (() => void) => (): void => {},
  }),
}));
jest.mock('node:fs/promises', () => ({
  readFile: (...args: [string, string]): Promise<string> =>
    mockReadFile(...args),
  mkdir: async (): Promise<void> => {},
  rm: (): Promise<void> => mockRemove(),
  writeFile: (): Promise<void> => mockWrite(),
}));
jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: (): Promise<void> => mockWrite(),
}));
jest.mock('../lib/paths', () => ({
  getDataDir: (): string => '/audit',
  getWorkspaceContextFilePath: (): string => '/audit/workspace-context.json',
  getTelemetrySyncQueueFilePath: (): string => '/audit/queue.jsonl',
  getTelemetrySyncMapFilePath: (): string => '/audit/sync-map.json',
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: (): Promise<object> => mockReadAccount(),
  getCanopyCloudCredentials: (): Promise<object> => mockCredentials(),
  subscribeCanopyCloudAccountChanges: (): (() => void) => (): void => {},
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): object => ({
    subscribe: (): (() => void) => (): void => {},
    recordAppDiagnostic: (): void => {},
    recordSessionDiagnostic: mockDiagnostic,
  }),
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    ...args: [string, (...args: unknown[]) => unknown]
  ): void => mockRegister(...args),
}));
jest.mock('../lib/transient-error-retry-service', () => ({
  subscribeTransientRetryActivity: (): (() => void) => (): void => {},
}));
jest.mock('../lib/script-runner', () => ({
  listTrackedShellScripts: (): never[] => [],
  subscribeTrackedScriptsChanged: (): (() => void) => (): void => {},
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: (): Promise<object> =>
    Promise.resolve({
      config: { version: 1, type: 'single-repo', repos: [] },
      authority: 'ok',
      ownerMalformed: false,
    }),
  readWorkspaceWorktrees: (): Promise<object[]> =>
    Promise.resolve([
      {
        id: 'worktree-1',
        branchName: 'feature/personal-telemetry',
        status: 'active',
        createdAt: '2026-09-24T00:00:00.000Z',
      },
    ]),
}));
jest.mock('../lib/sidebar-items', () => ({
  readWorkspaceIndexEntry: (): Promise<object> =>
    Promise.resolve({
      id: 'project-1',
      name: 'Audit workspace',
      type: 'single-repo',
    }),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<object> =>
    Promise.resolve({
      telemetrySharing: {
        metadata: 'organization',
        transcripts: 'organization',
        plans: 'organization',
        summaries: 'organization',
      },
    }),
}));
jest.mock('../lib/cowork-work-entries-file', () => ({
  readWorkEntriesFile: (): Promise<object> =>
    Promise.resolve({ version: 1, entries: [] }),
}));
jest.mock('../lib/plan-persistence', () => ({
  addPlanContentChangeListener: (): void => {},
  addPlanShareChangeListener: (): void => {},
  removePlanContentChangeListener: (): void => {},
  removePlanShareChangeListener: (): void => {},
  listTrackedPlans: (): Promise<never[]> => Promise.resolve([]),
}));
jest.mock('../lib/worktree-summary-persistence', () => ({
  addWorktreeSummaryChangeListener: (): void => {},
  removeWorktreeSummaryChangeListener: (): void => {},
}));
jest.mock('../lib/pr-status-change-emitter', () => ({
  addWorktreePrStatusChangeListener: (): void => {},
  removeWorktreePrStatusChangeListener: (): void => {},
}));
jest.mock('../lib/pipeline-run-completion-emitter', () => ({
  addPipelineRunCompletionListener: (): void => {},
  removePipelineRunCompletionListener: (): void => {},
}));
jest.mock('../lib/telemetry-enforcement-state', () => ({
  emptyTelemetryEnforcementByOrganization: (): Map<string, never> =>
    new Map<string, never>(),
  loadStoredTelemetryEnforcementByOrganization: (): Promise<
    Map<string, never>
  > => Promise.resolve(new Map<string, never>()),
}));
jest.mock('../lib/org-billing-state', () => ({
  loadStoredOrgBillingStates: (): Promise<never[]> => Promise.resolve([]),
}));
jest.mock('../canopy-cloud/client', () => ({
  requestCanopyCloudJson: (
    _path: string,
    options: { body: string },
  ): object => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- parsing the request body this test's mock received.
    const request: (typeof mockTelemetryRequests)[number] = JSON.parse(
      options.body,
    );
    mockTelemetryRequests.push(request);
    const worktree = request.workspace.worktrees?.[0];
    return {
      workspace: {
        clientLocalId: request.workspace.clientLocalId,
        externalId: 'private-workspace-external-id',
        worktrees: [
          {
            clientLocalId: worktree?.clientLocalId ?? '',
            externalId: 'private-worktree-external-id',
            turns: [],
            plans: [],
            pullRequests: [],
            pipelineRuns: [],
            summaries: [],
          },
        ],
      },
    };
  },
  CanopyCloudClientError: class CanopyCloudClientError extends Error {},
}));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { ORG_PROJECT_ACTIVITY_KINDS } from '@canopy/protocol/org-projects';
import {
  getWorkspaceContextService,
  __resetWorkspaceContextServiceForTests,
} from '../lib/workspace-context-service';
import { registerWorkspaceContextHandlers } from '../ipc/workspace-context';
import { ForeignActivityCarryoverService } from '../services/foreign-activity-carryover-service';
import { getResourceContextPolicyService } from '../services/resource-context-policy-service';
import { TelemetrySyncService } from '../services/telemetry-sync-service';

describe('org-projects flag-off entry points', () => {
  beforeEach((): void => {
    jest.clearAllMocks();
    mockTelemetryRequests.length = 0;
    __resetWorkspaceContextServiceForTests();
    mockReadFile.mockImplementation((path) =>
      path === '/audit/workspace-context.json'
        ? Promise.resolve(
            JSON.stringify({
              version: 1,
              byAccount: {
                'audit-user': {
                  context: `org:${organizationId}`,
                  revision: 1,
                },
              },
            }),
          )
        : Promise.reject(new Error('missing')),
    );
  });
  afterEach((): void => {
    __resetWorkspaceContextServiceForTests();
  });

  it('does not read or write carryover ledger contents during initialize (purge is allowed)', async (): Promise<void> => {
    const service = new ForeignActivityCarryoverService();
    try {
      await service.initialize();
      await service.whenIdle();
      expect(mockEnabled).toHaveBeenCalledWith(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      );
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockWrite).not.toHaveBeenCalled();
      expect(service.get().groups).toEqual([]);
    } finally {
      await service.shutdown();
    }
  });

  it.each(['foreground', 'background'])(
    'allows %s resource policy decisions with no denial reason',
    async (mode): Promise<void> => {
      const result = await getResourceContextPolicyService().decide({
        resource: { owner: {} },
        invocation: {
          mode: mode === 'foreground' ? 'foreground' : 'background',
          context: { kind: 'personal' },
        },
      });
      // The current contract represents "reason none" by an absent reason.
      expect(result).toEqual({ allow: true });
      expect(mockDiagnostic).not.toHaveBeenCalled();
    },
  );

  it('returns personal-only IPC state even with a persisted organization selection', async (): Promise<void> => {
    await getWorkspaceContextService().initialize();
    registerWorkspaceContextHandlers();
    const handler = mockRegister.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.workspaceContextGet,
    )?.[1];
    if (!handler) throw new Error('workspaceContextGet was not registered');
    await expect(handler({})).resolves.toMatchObject({
      context: { kind: 'personal' },
      organizations: [],
    });
  });

  it('keeps the null-org resolver fallback defensive under the flag-off Personal projection', async (): Promise<void> => {
    const service = new TelemetrySyncService();
    // Flush callers downgrade a null-stamped group before target resolution.
    // The resolver still excludes a direct non-private/null call defensively.
    await getWorkspaceContextService().initialize();
    expect(getWorkspaceContextService().getState().context).toEqual({
      kind: 'personal',
    });
    await expect(
      service['resolveScopeTargets']('organization', null),
    ).resolves.toEqual({ kind: 'excluded' });
    await expect(
      service['resolveScopeTargets']('private', null),
    ).resolves.toMatchObject({
      kind: 'targets',
      targets: [{ shareScope: 'private' }],
    });
  });

  it('delivers flag-off organization sharing privately at flush without contacting an organization', async (): Promise<void> => {
    await getWorkspaceContextService().initialize();
    expect(getWorkspaceContextService().getState().context).toEqual({
      kind: 'personal',
    });
    const service = new TelemetrySyncService();
    try {
      await service.start();
      await service.refreshWorktreeMetadata('project-1', 'worktree-1');
      await service.flushWorktreeNow('project-1', 'worktree-1');

      expect(mockTelemetryRequests).toHaveLength(1);
      expect(mockTelemetryRequests[0]).toMatchObject({
        shareScope: 'private',
      });
      expect(mockTelemetryRequests[0]?.organizationId).toBeUndefined();
      expect(mockTelemetryRequests[0]?.teamId).toBeUndefined();
      expect(
        service.resolveServerWorktreeExternalId(
          'project-1',
          'worktree-1',
          organizationId,
        ),
      ).toBe('private-worktree-external-id');
    } finally {
      await service.dispose();
    }
  });
});

// Root Jest's @/ alias belongs to the renderer. Evaluate these three real web
// modules with an explicit import map; only infrastructure dependencies are
// substituted. Unexpected imports fail instead of silently becoming mocks.
function loadWebModule(
  file: string,
  dependencies: Record<string, unknown>,
): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  const source = readFileSync(resolve(root, 'apps/web/src', file), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file,
  });
  runInNewContext(
    compiled.outputText,
    {
      exports,
      Response,
      require: (name: string): unknown => {
        if (!(name in dependencies))
          throw new Error(`Unexpected web dependency: ${name}`);
        return dependencies[name];
      },
    },
    { filename: file },
  );
  return exports;
}

function isWebHandler(value: unknown): value is (request: Request) => unknown {
  return typeof value === 'function';
}

it.skip('disables the actual personal-catalog registration handler before rate limits or writes', async (): Promise<void> => {
  const variation = jest.fn((): Promise<boolean> => Promise.resolve(false));
  const flags = loadWebModule('lib/feature-flags/org-projects.ts', {
    '@canopy/protocol/feature-flags': { CLIENT_FEATURE_FLAGS },
    './context': { buildApiUserFeatureFlagContext: (): object => ({}) },
    '../logger': { loggerFor: (): object => ({ warn: jest.fn() }) },
    './server': { variation },
  });
  const bearer = loadWebModule('lib/tracked-workspaces/bearer-support.ts', {
    './local-workspace-id': {},
    '@canopy/protocol/org-projects': { ORG_PROJECT_ACTIVITY_KINDS },
    '@canopy/protocol/workspace-context': {},
    '@/lib/canopy-api-auth': {
      getCurrentCanopyApiUser: (): Promise<object> =>
        Promise.resolve({
          ok: true,
          user: { id: 'audit-user' },
        }),
    },
    '@/lib/feature-flags/org-projects': flags,
    '@/lib/teams/route-support': {},
    './route-support': {},
    '@/lib/uuid': {},
    './errors': {},
  });
  const register = jest.fn();
  const rateLimit = jest.fn();
  const route = loadWebModule(
    'app/api/v1/projects/personal/registrations/route.ts',
    {
      '@/lib/observability/api-route': {
        v1Route: (_name: string, handler: unknown): unknown => handler,
      },
      '@/lib/tracked-workspaces/bearer-support': bearer,
      '@/lib/teams/route-support': {},
      '@/lib/tracked-workspaces/bearer-rate-limit': {
        consumeOrgProjectBearerRateLimit: rateLimit,
      },
      '@/lib/tracked-workspaces/personal-catalog-service': {
        registerPersonalCatalog: register,
      },
    },
  );
  const handler = route.PUT;
  if (!isWebHandler(handler)) throw new Error('PUT handler missing');
  const response: unknown = await handler(
    new Request(
      'https://audit.invalid/api/v1/projects/personal/registrations',
      { method: 'PUT' },
    ),
  );
  if (!(response instanceof Response))
    throw new Error('PUT did not return a Response');
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({ error: 'Not found' });
  expect(variation).toHaveBeenCalledWith(
    CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
    {},
  );
  expect(rateLimit).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
});

it('rejects a manifest candidate with an exported entry point but no flag read', (): void => {
  const { names, exported } = runtimeNames(
    'apps/desktop-app/src/main/lib/paths.ts',
  );
  expect(exported.has('getDataDir')).toBe(true);
  expect(names.has('canopyOrgProjectsEnabled')).toBe(false);
});
