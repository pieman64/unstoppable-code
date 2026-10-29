import { getProjectActionsDir } from '../../pipelines/config-paths';
import { resolveAction } from '../pipelines/action-resolver';
import type { ChildPipelineAuthorization } from '../pipelines/executor/child-pipeline-resolver';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as childResolver from '../pipelines/executor/child-pipeline-resolver';
import * as pipelineStore from '../../pipelines/store';
import { decideResourceContext } from '../../lib/resource-context-policy';
import {
  authorizePipelineContextResources,
  parseExecutionContext,
  decideCliExecutionContext,
  pipelineContextResources,
} from '../background-execution-context';
import type { Pipeline } from '../../types/pipeline';
const pipeline: Pipeline = {
  name: 'test',
  on: 'dispatch',
  jobs: { build: { steps: [{ run: 'echo ok' }] } },
};
it('parses personal and normalizes organization UUIDs', (): void => {
  expect(parseExecutionContext('personal')).toEqual({ kind: 'personal' });
  expect(
    parseExecutionContext('org:AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'),
  ).toEqual({
    kind: 'organization',
    organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  });
});
it.each(['', 'org:', 'org:not-a-uuid', 'Personal', 'personal:org'])(
  'rejects malformed context %s',
  (value): void => {
    expect(() => parseExecutionContext(value)).toThrow('Expected --context');
  },
);
it('allows caller-owned local definitions in personal and organization contexts', async (): Promise<void> => {
  expect(await decideCliExecutionContext('personal', pipeline)).toEqual({
    allow: true,
  });
  expect(
    await decideCliExecutionContext(
      'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      pipeline,
    ),
  ).toEqual({ allow: true });
});
it.each(['builtin/agent-prompt'])(
  'allows bundled action %s in a strict organization context',
  (uses): void => {
    const graph = pipelineContextResources(
      {
        ...pipeline,
        jobs: { build: { steps: [{ uses, with: {} }] } },
      },
      { type: 'system' },
    );
    expect(graph).toEqual([
      { owner: { type: 'system' } },
      { owner: { type: 'system' } },
    ]);
    for (const resource of graph) {
      expect(
        decideResourceContext({
          resource,
          invocation: {
            mode: 'background',
            context: {
              kind: 'organization',
              organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            },
          },
        }),
      ).toEqual({ allow: true });
    }
  },
);
it.each([
  'marketplace/action',
  'plugin/action',
  'project/action',
  '/personal/action',
  'builtin/not-a-bundled-action',
  'builtin/../../outside',
])('keeps unverified action %s unknown under strict policy', (uses): void => {
  const graph = pipelineContextResources(
    { ...pipeline, jobs: { build: { steps: [{ uses, with: {} }] } } },
    { type: 'system' },
  );
  expect(graph).toEqual([{ owner: { type: 'system' } }, { owner: undefined }]);
  expect(
    decideResourceContext({
      resource: graph[1],
      invocation: {
        mode: 'background',
        context: {
          kind: 'organization',
          organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        },
      },
    }),
  ).toEqual({ allow: false, reason: 'unknown-provenance' });
});

it.each(['builtin/agent-prompt', 'plugin/action'])(
  'checks CLI local pipeline references independently: %s',
  async (uses): Promise<void> => {
    expect(
      await decideCliExecutionContext(
        'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        {
          ...pipeline,
          jobs: { build: { steps: [{ uses, with: {} }] } },
        },
      ),
    ).toEqual(
      uses.startsWith('builtin/')
        ? { allow: true }
        : { allow: false, reason: 'unknown-provenance' },
    );
  },
);

it('denies an unresolved dynamic nested pipeline before dispatch', async (): Promise<void> => {
  expect(
    await decideCliExecutionContext('personal', {
      ...pipeline,
      jobs: {
        build: {
          steps: [
            {
              uses: 'builtin/run-pipeline',
              with: { pipeline: '${{ inputs.child }}' },
            },
          ],
        },
      },
    }),
  ).toEqual({ allow: false, reason: 'unsupported-target' });
});
it('denies a missing nested pipeline before dispatch', async (): Promise<void> => {
  expect(
    await decideCliExecutionContext('personal', {
      ...pipeline,
      jobs: {
        build: {
          steps: [
            {
              uses: 'builtin/run-pipeline',
              with: { pipeline: 'nonexistent-can-2962-child' },
            },
          ],
        },
      },
    }),
  ).toEqual({ allow: false, reason: 'unsupported-target' });
});

it('allows a Personal file child and denies file cycles without looping', async (): Promise<void> => {
  const cwd = await mkdtemp(join(tmpdir(), 'can-2962-'));
  const wrapper: Pipeline = {
    ...pipeline,
    jobs: {
      build: {
        steps: [
          { uses: 'builtin/run-pipeline', with: { pipeline: 'child.yaml' } },
        ],
      },
    },
  };
  try {
    await writeFile(
      join(cwd, 'child.yaml'),
      'name: child\non: dispatch\njobs:\n  build:\n    steps:\n      - run: echo ok\n',
    );
    expect(
      await decideCliExecutionContext('personal', wrapper, { cwd }),
    ).toEqual({ allow: true });
    await writeFile(
      join(cwd, 'child.yaml'),
      'name: child\non: dispatch\njobs:\n  build:\n    steps:\n      - uses: builtin/run-pipeline\n        with:\n          pipeline: child.yaml\n',
    );
    expect(
      await decideCliExecutionContext('personal', wrapper, { cwd }),
    ).toEqual({ allow: false, reason: 'unsupported-target' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('revalidates a stored organization child of a SYSTEM wrapper after access removal', async (): Promise<void> => {
  const organizationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const owner = {
    type: 'organization' as const,
    id: organizationId,
    name: 'Org',
  };
  const resolve = jest
    .spyOn(childResolver, 'resolveChildPipeline')
    .mockResolvedValue({
      pipeline,
      pipelineId: 'org-child',
      preferenceLocator: { type: 'stored', source: 'user', value: 'org-child' },
    });
  const stored = jest
    .spyOn(pipelineStore, 'getStoredPipelineBySource')
    .mockReturnValue({
      success: true,
      data: {
        content: pipeline,
        info: {
          id: 'org-child',
          name: 'Child',
          description: '',
          icon: '',
          filename: 'child.yaml',
          createdAt: '',
          updatedAt: '',
          source: 'user',
          readonly: false,
          owner,
        },
      },
    });
  const graph = pipelineContextResources(
    {
      ...pipeline,
      jobs: {
        build: {
          steps: [
            { uses: 'builtin/run-pipeline', with: { pipeline: 'org-child' } },
          ],
        },
      },
    },
    { type: 'system' },
  );
  try {
    const checked: unknown[] = [];
    const result = await authorizePipelineContextResources(
      graph,
      (resource) => {
        checked.push(resource.owner);
        return Promise.resolve(
          resource.owner === owner
            ? { allow: false, reason: 'access-removed' }
            : { allow: true },
        );
      },
    );
    expect(result).toEqual({ allow: false, reason: 'access-removed' });
    expect(checked).toContain(owner);
    expect(
      await decideCliExecutionContext('personal', {
        ...pipeline,
        jobs: {
          build: {
            steps: [
              { uses: 'builtin/run-pipeline', with: { pipeline: 'org-child' } },
            ],
          },
        },
      }),
    ).toEqual({ allow: false, reason: 'unknown-provenance' });
  } finally {
    resolve.mockRestore();
    stored.mockRestore();
  }
});

it('bounds nested inline graphs at sixteen levels', async (): Promise<void> => {
  const resolve = jest
    .spyOn(childResolver, 'resolveChildPipeline')
    .mockImplementation(() =>
      Promise.resolve({
        pipeline: {
          ...pipeline,
          jobs: {
            build: {
              steps: [
                {
                  uses: 'builtin/run-pipeline',
                  with: { pipeline: String(resolve.mock.calls.length) },
                },
              ],
            },
          },
        },
        pipelineId: 'child',
        preferenceLocator: {
          type: 'file',
          value: String(resolve.mock.calls.length),
        },
      }),
    );
  try {
    expect(
      await decideCliExecutionContext('personal', {
        ...pipeline,
        jobs: {
          build: {
            steps: [
              { uses: 'builtin/run-pipeline', with: { pipeline: 'root' } },
            ],
          },
        },
      }),
    ).toEqual({ allow: false, reason: 'unsupported-target' });
    expect(resolve).toHaveBeenCalledTimes(16);
  } finally {
    resolve.mockRestore();
  }
});

it('allows legacy Personal local actions while keeping organization provenance strict', async (): Promise<void> => {
  const cwd = await mkdtemp(join(tmpdir(), 'can-2962-action-'));
  try {
    const actionDir = join(getProjectActionsDir(cwd), 'local-action');
    await mkdir(actionDir, { recursive: true });
    await writeFile(
      join(actionDir, 'action.yml'),
      'name: Local action\nruns:\n  using: node\n  main: index.js\n',
    );
    await writeFile(
      join(actionDir, 'index.js'),
      'process.stdout.write("ok");\n',
    );
    expect(resolveAction('project/local-action', cwd)).toMatchObject({
      name: 'Local action',
    });
    const local: Pipeline = {
      ...pipeline,
      jobs: { build: { steps: [{ uses: 'project/local-action', with: {} }] } },
    };
    expect(
      await decideCliExecutionContext('personal', local, {
        cwd,
        repoPath: cwd,
      }),
    ).toEqual({ allow: true });
    expect(
      await decideCliExecutionContext(
        'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        local,
        { cwd, repoPath: cwd },
      ),
    ).toEqual({ allow: false, reason: 'unknown-provenance' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('authorizes the same relative child that a stored parent executes from cwd', async (): Promise<void> => {
  const cwd = await mkdtemp(join(tmpdir(), 'can-2962-cwd-'));
  const storage = await mkdtemp(join(tmpdir(), 'can-2962-store-'));
  const parentPath = jest
    .spyOn(pipelineStore, 'getStoredPipelinePathWithSource')
    .mockImplementation((id) =>
      id === 'parent'
        ? {
            success: true,
            data: { filePath: join(storage, 'parent.yaml'), source: 'user' },
          }
        : { success: false, error: 'Missing' },
    );
  try {
    await writeFile(
      join(storage, 'child.yaml'),
      'name: Storage child\non: dispatch\njobs: {}\n',
    );
    await writeFile(
      join(cwd, 'child.yaml'),
      'name: Runtime child\non: dispatch\njobs:\n  build:\n    steps:\n      - uses: plugin/unverified\n',
    );
    const graph = pipelineContextResources(
      {
        ...pipeline,
        jobs: {
          build: {
            steps: [
              {
                uses: 'builtin/run-pipeline',
                with: { pipeline: 'child.yaml' },
              },
            ],
          },
        },
      },
      { type: 'system' },
      { cwd, pipelineId: 'parent' },
    );
    expect(
      await authorizePipelineContextResources(graph, (resource) =>
        Promise.resolve(
          decideResourceContext({
            resource,
            invocation: { mode: 'background', context: { kind: 'personal' } },
          }),
        ),
      ),
    ).toEqual({ allow: false, reason: 'unknown-provenance' });
  } finally {
    parentPath.mockRestore();
    await rm(cwd, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

it('fences authorized child identity and content at execution resolution', async (): Promise<void> => {
  const cwd = await mkdtemp(join(tmpdir(), 'can-2962-fence-'));
  const authorizations: ChildPipelineAuthorization[] = [];
  const target = { cwd, pipelineRef: 'child.yaml' };
  try {
    await writeFile(
      join(cwd, 'child.yaml'),
      'name: Child\non: dispatch\njobs: {}\n',
    );
    const graph = pipelineContextResources(
      {
        ...pipeline,
        jobs: {
          build: {
            steps: [
              {
                uses: 'builtin/run-pipeline',
                with: { pipeline: 'child.yaml' },
              },
            ],
          },
        },
      },
      { type: 'system' },
      { cwd },
    );
    expect(
      await authorizePipelineContextResources(
        graph,
        () => Promise.resolve({ allow: true }),
        new Set(),
        authorizations,
      ),
    ).toEqual({ allow: true });
    expect(authorizations).toHaveLength(1);
    await expect(
      childResolver.resolveChildPipeline({ ...target, authorizations }),
    ).resolves.toMatchObject({ pipeline: { name: 'Child' } });
    await writeFile(
      join(cwd, 'child.yaml'),
      'name: Replaced\non: dispatch\njobs: {}\n',
    );
    await expect(
      childResolver.resolveChildPipeline({ ...target, authorizations }),
    ).rejects.toThrow("Couldn't confirm where this runs");
    await writeFile(
      join(cwd, 'child.yaml'),
      'name: Child\non: dispatch\njobs: {}\n',
    );
    const changedIdentity = jest
      .spyOn(pipelineStore, 'getStoredPipelinePathWithSource')
      .mockReturnValue({
        success: true,
        data: { source: 'user', filePath: join(cwd, 'child.yaml') },
      });
    try {
      await expect(
        childResolver.resolveChildPipeline({ ...target, authorizations }),
      ).rejects.toThrow("Couldn't confirm where this runs");
    } finally {
      changedIdentity.mockRestore();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('requires both lane access and the authorized snapshot for host-resolved children', async (): Promise<void> => {
  const child: childResolver.ResolvedChildPipeline = {
    pipeline,
    pipelineId: 'shared-child',
    preferenceLocator: {
      type: 'stored',
      source: 'user',
      value: 'shared-child',
    },
  };
  const parent: childResolver.ResolveChildPipelineArgs['parent'] = {
    owner: { type: 'system' },
  };
  const target = { cwd: '/project', pipelineRef: 'shared-child', parent };
  const resolvePipelineResource = jest.fn<
    ReturnType<
      NonNullable<
        childResolver.ResolveChildPipelineArgs['resolvePipelineResource']
      >
    >,
    Parameters<
      NonNullable<
        childResolver.ResolveChildPipelineArgs['resolvePipelineResource']
      >
    >
  >();
  const args = {
    ...target,
    resolvePipelineResource,
    authorizations: [childResolver.childPipelineAuthorization(target, child)],
  };

  resolvePipelineResource.mockResolvedValue(child);
  await expect(childResolver.resolveChildPipeline(args)).resolves.toEqual(
    child,
  );
  expect(resolvePipelineResource).toHaveBeenCalledWith('shared-child', parent);

  resolvePipelineResource.mockRejectedValue(
    new Error('Pipeline unavailable (access-removed)'),
  );
  await expect(childResolver.resolveChildPipeline(args)).rejects.toThrow(
    'access-removed',
  );

  resolvePipelineResource.mockResolvedValue({
    ...child,
    pipeline: { ...pipeline, name: 'Changed after authorization' },
  });
  await expect(childResolver.resolveChildPipeline(args)).rejects.toThrow(
    "Couldn't confirm where this runs",
  );
});

it('classifies override-only bundled actions as system-owned', async (): Promise<void> => {
  const cwd = await mkdtemp(join(tmpdir(), 'context-override-'));
  try {
    const bundledActionsDir = join(cwd, 'actions');
    await mkdir(join(bundledActionsDir, 'override-only'), { recursive: true });
    await writeFile(
      join(bundledActionsDir, 'override-only', 'action.yml'),
      'name: Override\nruns:\n  using: node\n  main: index.js\n',
    );
    await writeFile(join(bundledActionsDir, 'override-only', 'index.js'), '');
    const location = { cwd, bundledActionsDir };
    const local: Pipeline = {
      ...pipeline,
      jobs: { build: { steps: [{ uses: 'builtin/override-only' }] } },
    };
    expect(
      pipelineContextResources(local, { type: 'system' }, location),
    ).toEqual([{ owner: { type: 'system' } }, { owner: { type: 'system' } }]);
    expect(
      await decideCliExecutionContext(
        'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        local,
        location,
      ),
    ).toEqual({ allow: true });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it.each(['user', 'bundled'])(
  'allows ownerless stored %s children of a Personal parent in strict background mode',
  async (source): Promise<void> => {
    if (source !== 'user' && source !== 'bundled')
      throw new Error('Unexpected source');
    const child = { name: 'Child', jobs: {} };
    const resolve = jest
      .spyOn(childResolver, 'resolveChildPipeline')
      .mockResolvedValue({
        pipeline: child,
        pipelineId: 'child',
        preferenceLocator: { type: 'stored', source, value: 'child' },
      });
    const stored = jest
      .spyOn(pipelineStore, 'getStoredPipelineBySource')
      .mockReturnValue({
        success: true,
        data: {
          content: child,
          info: {
            id: 'child',
            name: 'Child',
            source,
            path: '/stored/child.yaml',
          },
        },
      });
    const graph = pipelineContextResources(
      {
        jobs: {
          build: {
            steps: [
              { uses: 'builtin/run-pipeline', with: { pipeline: 'child' } },
            ],
          },
        },
      },
      { shareScope: 'private' },
    );
    const owners: unknown[] = [];
    try {
      expect(
        await authorizePipelineContextResources(
          graph,
          (resource): Promise<ReturnType<typeof decideResourceContext>> => {
            owners.push(resource.owner);
            return Promise.resolve(
              decideResourceContext(
                {
                  resource,
                  invocation: {
                    mode: 'background',
                    context: { kind: 'personal' },
                    executionContext: 'personal',
                  },
                },
                { strict: true },
              ),
            );
          },
        ),
      ).toEqual({ allow: true });
      expect(owners.at(-1)).toEqual(
        source === 'user' ? { shareScope: 'private' } : { type: 'system' },
      );
    } finally {
      resolve.mockRestore();
      stored.mockRestore();
    }
  },
);

it('requires a host resolver for capability references instead of treating them as local CLI resources', async (): Promise<void> => {
  const selected = {
    ...pipeline,
    plugin_collections: [{ id: 'review', name: 'Review', defaults: [] }],
  };
  expect(
    pipelineContextResources(selected, { type: 'system' })[1],
  ).toMatchObject({
    requiresHostAuthorization: true,
    capabilities: { pipeline: selected },
  });
  expect(await decideCliExecutionContext('personal', selected)).toEqual({
    allow: false,
    reason: 'unknown-provenance',
  });
});
