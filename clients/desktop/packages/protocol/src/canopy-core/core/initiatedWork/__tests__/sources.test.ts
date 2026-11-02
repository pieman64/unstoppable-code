import { CORE_QUERY_DEFINITIONS } from '../../registry';
import {
  CoreInitiatedWorkSourceGetParamsSchema,
  CoreInitiatedWorkSourceGetResultSchema,
  CoreInitiatedWorkSourceListParamsSchema,
  CoreInitiatedWorkSourceListResultSchema,
} from '../sources';

describe('core.initiatedWork.source contracts', () => {
  it('registers list and get as core-only reads that need core.initiatedWork.read', () => {
    for (const name of [
      'core.initiatedWork.source.list',
      'core.initiatedWork.source.get',
    ] as const) {
      expect(CORE_QUERY_DEFINITIONS[name]).toMatchObject({
        kind: 'query',
        plane: 'core',
        domain: 'initiatedWork',
        version: 1,
        placement: 'core-only',
        idempotency: 'inherent',
        requiredGrants: ['core.initiatedWork.read'],
      });
    }
  });

  it('accepts hook targets by identifier only', () => {
    expect(
      CoreInitiatedWorkSourceListParamsSchema.safeParse({
        sourceKind: 'hook',
        target: {
          kind: 'workspace-repo',
          workspaceId: 'ws-1',
          repoId: 'repo-a',
          worktreeId: 'wt-1',
        },
      }).success,
    ).toBe(true);
    for (const params of [
      {
        sourceKind: 'automation',
        target: { kind: 'project', workspaceId: 'w' },
      },
      {
        sourceKind: 'hook',
        target: { kind: 'project', workspaceId: 'w', repoPath: '/repos/w' },
      },
      {
        sourceKind: 'hook',
        target: { kind: 'workspace-repo', workspaceId: 'w' },
      },
    ]) {
      expect(
        CoreInitiatedWorkSourceListParamsSchema.safeParse(params).success,
      ).toBe(false);
    }
    expect(
      CoreInitiatedWorkSourceGetParamsSchema.safeParse({
        sourceKind: 'hook',
        target: { kind: 'project', workspaceId: 'ws-1' },
      }).success,
    ).toBe(false);
  });

  it('keeps hook actions JSON-only with a closed discriminator', () => {
    const action = {
      type: 'chat',
      prompt: 'Review',
      pluginSelections: { skills: ['a'] },
    };
    expect(
      CoreInitiatedWorkSourceListResultSchema.safeParse({
        sources: [
          {
            sourceKind: 'hook',
            triggerName: 'pr:create',
            origin: 'repo-canopy',
            actions: [action],
          },
          {
            sourceKind: 'hook',
            triggerName: 'pr:closed',
            origin: 'local-disabled',
            actions: null,
          },
        ],
      }).success,
    ).toBe(true);
    for (const bad of [
      { ...action, type: 'script' },
      { ...action, prompt: undefined },
      { ...action, at: new Date() },
    ]) {
      expect(
        CoreInitiatedWorkSourceGetResultSchema.safeParse({
          sourceKind: 'hook',
          triggerName: 'pr:create',
          effectiveActions: [bad],
          layers: [],
        }).success,
      ).toBe(false);
    }
  });
});
