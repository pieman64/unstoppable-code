import type {
  PortalHookDescriptor,
  PortalHookRunProjection,
} from '@canopy/protocol/portal';
import { portalHooksToSectionModel } from '../portal-hooks-section-mapper';

describe('portalHooksToSectionModel', () => {
  it('maps descriptor fields, target narrowing, pause state, and grouped labels', () => {
    const descriptors: PortalHookDescriptor[] = [
      {
        name: 'Web — PR created',
        hookKey: 'workspace-repo:web:pr:create',
        triggerName: 'pr:create',
        target: 'workspace-repo',
        repoId: 'web',
        repoName: 'Web',
        paused: true,
      },
      {
        name: 'Unknown target',
        hookKey: 'unknown',
        triggerName: 'custom-trigger',
        target: 'future-target',
      },
    ];

    const model = portalHooksToSectionModel(descriptors, []);

    expect(model.entries).toEqual([
      {
        hook: {
          hookKey: 'workspace-repo:web:pr:create',
          triggerName: 'pr:create',
          label: 'Web — PR created',
          target: 'workspace-repo',
          repoId: 'web',
          repoName: 'Web',
          actions: [],
        },
        groupedLabel: 'PR Created',
        paused: true,
        runDisabled: false,
      },
      {
        hook: {
          hookKey: 'unknown',
          triggerName: 'custom-trigger',
          label: 'Unknown target',
          target: 'project',
          actions: [],
        },
        groupedLabel: 'Custom Trigger',
        paused: false,
        runDisabled: false,
      },
    ]);
    expect(model.unconfiguredWatchers).toEqual([]);
  });

  it.each([
    ['running', 'running'],
    ['queued', 'running'],
    ['pending', 'running'],
    ['stopping', 'running'],
    ['completed', 'success'],
    ['success', 'success'],
    ['succeeded', 'success'],
    ['cancelled', 'stopped'],
    ['stopped', 'stopped'],
    ['failed', 'failed'],
    ['future-status', 'failed'],
  ])('maps portal status %s to body status %s', (portalStatus, bodyStatus) => {
    const runs: PortalHookRunProjection[] = [
      {
        name: 'Hook',
        hookKey: 'hook',
        triggerName: 'on-save',
        status: portalStatus,
      },
    ];

    expect(portalHooksToSectionModel([], runs).runs.hook?.status).toBe(
      bodyStatus,
    );
  });

  it('splits normalized output tails and retains only the latest orphan run', () => {
    const runs: PortalHookRunProjection[] = [
      {
        name: 'Old orphan',
        hookKey: 'orphan',
        triggerName: 'on-save',
        status: 'failed',
        startedAt: '2026-07-26T10:00:00.000Z',
      },
      {
        name: 'Orphan',
        hookKey: 'orphan',
        triggerName: 'on-save',
        status: 'completed',
        startedAt: '2026-07-26T11:00:00.000Z',
        finishedAt: '2026-07-26T11:00:02.500Z',
        outputTail: 'one\r\ntwo\rthree\n',
      },
    ];

    const model = portalHooksToSectionModel([], runs);

    expect(model.entries).toHaveLength(1);
    expect(model.entries[0]?.hook.label).toBe('Orphan');
    expect(model.entries[0]?.runDisabled).toBe(true);
    expect(model.runs.orphan).toEqual({
      label: 'Orphan',
      status: 'success',
      outputLines: ['one', 'two', 'three'],
      exitCode: null,
      timedOut: false,
      durationMs: 2500,
      startedAt: Date.parse('2026-07-26T11:00:00.000Z'),
    });
  });

  it('preserves interior empty output lines while dropping one trailing line', () => {
    const runs: PortalHookRunProjection[] = [
      {
        name: 'Interior empty line',
        hookKey: 'interior',
        triggerName: 'on-save',
        status: 'completed',
        outputTail: 'one\n\ntwo\n',
      },
      {
        name: 'Two trailing lines',
        hookKey: 'trailing',
        triggerName: 'on-save',
        status: 'completed',
        outputTail: 'one\n\n',
      },
    ];

    const model = portalHooksToSectionModel([], runs);

    expect(model.runs.interior?.outputLines).toEqual(['one', '', 'two']);
    expect(model.runs.trailing?.outputLines).toEqual(['one', '']);
  });

  it('handles absent output and missing, invalid, or reversed timestamps', () => {
    const runs: PortalHookRunProjection[] = [
      {
        name: 'Missing',
        hookKey: 'missing',
        triggerName: 'on-save',
        status: 'completed',
        startedAt: '2026-07-26T11:00:00.000Z',
      },
      {
        name: 'Invalid',
        hookKey: 'invalid',
        triggerName: 'on-save',
        status: 'completed',
        startedAt: 'invalid',
        finishedAt: 'also-invalid',
        outputTail: '',
      },
      {
        name: 'Reversed',
        hookKey: 'reversed',
        triggerName: 'on-save',
        status: 'completed',
        startedAt: '2026-07-26T12:00:00.000Z',
        finishedAt: '2026-07-26T11:00:00.000Z',
      },
    ];

    const model = portalHooksToSectionModel([], runs);

    expect(model.runs.missing?.durationMs).toBe(0);
    expect(model.runs.missing?.outputLines).toEqual([]);
    expect(model.runs.invalid?.durationMs).toBe(0);
    expect(model.runs.invalid?.startedAt).toBe(0);
    expect(model.runs.invalid?.outputLines).toEqual([]);
    expect(model.runs.reversed?.durationMs).toBe(0);
  });

  it('disables descriptor runs while their latest run is active or stopping', () => {
    const descriptors: PortalHookDescriptor[] = [
      {
        name: 'Hook',
        hookKey: 'hook',
        triggerName: 'on-save',
      },
    ];
    const runs: PortalHookRunProjection[] = [
      {
        name: 'Hook',
        hookKey: 'hook',
        triggerName: 'on-save',
        status: 'stopping',
      },
    ];

    expect(
      portalHooksToSectionModel(descriptors, runs).entries[0]?.runDisabled,
    ).toBe(true);
  });

  it('combines host disablement with active runs and mirrors desktop trigger ordering', () => {
    const descriptors: PortalHookDescriptor[] = [
      {
        name: 'Merged',
        hookKey: 'workspace-root:pr:merged',
        triggerName: 'pr:merged',
        target: 'workspace-root',
      },
      {
        name: 'Created',
        hookKey: 'workspace-root:pr:create',
        triggerName: 'pr:create',
        target: 'workspace-root',
        runDisabled: true,
        runDisabledReason: 'Manual run requires an active PR',
      },
      {
        name: 'Repo comments',
        hookKey: 'workspace-repo:web:pr:update:comments',
        triggerName: 'pr:update:comments',
        target: 'workspace-repo',
        repoId: 'web',
      },
      {
        name: 'Repo created',
        hookKey: 'workspace-repo:web:pr:create',
        triggerName: 'pr:create',
        target: 'workspace-repo',
        repoId: 'web',
      },
    ];

    const model = portalHooksToSectionModel(descriptors, []);

    expect(model.entries.map((entry) => entry.hook.hookKey)).toEqual([
      'workspace-root:pr:create',
      'workspace-root:pr:merged',
      'workspace-repo:web:pr:create',
      'workspace-repo:web:pr:update:comments',
    ]);
    expect(model.entries[0]).toMatchObject({
      runDisabled: true,
      runDisabledTitle: 'Manual run requires an active PR',
    });
    expect(model.entries[1]?.runDisabled).toBe(false);
  });
  it('labels the merge queue triggers and orders them before the merge', () => {
    const descriptor = (triggerName: string): PortalHookDescriptor => ({
      name: triggerName,
      hookKey: `project:${triggerName}`,
      triggerName,
      target: 'project',
    });
    const model = portalHooksToSectionModel(
      [
        'pr:merged',
        'pr:queue:entered',
        'pr:merge-conflicts',
        'pr:queue:removed',
      ].map(descriptor),
      [],
    );

    expect(
      model.entries.map((entry) => [
        entry.hook.triggerName,
        entry.groupedLabel,
      ]),
    ).toEqual([
      ['pr:merge-conflicts', 'PR Merge Conflicts Detected'],
      ['pr:queue:removed', 'PR Removed From Merge Queue'],
      ['pr:queue:entered', 'PR Entered Merge Queue'],
      ['pr:merged', 'PR Merged'],
    ]);
  });
});
