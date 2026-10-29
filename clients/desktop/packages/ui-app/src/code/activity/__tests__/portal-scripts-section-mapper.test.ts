import type {
  PortalScriptDescriptor,
  PortalScriptRunProjection,
} from '@canopy/protocol/portal';
import { portalScriptsToSectionModel } from '../portal-scripts-section-mapper';

describe('portalScriptsToSectionModel', () => {
  const descriptor = (
    scriptName: string,
    target = 'workspace-root',
    scriptKey = `workspace-${scriptName}`,
  ): PortalScriptDescriptor => ({
    name: scriptName,
    scriptKey,
    scriptName,
    target,
  });

  it('maps descriptor display fields and conservatively degrades missing metadata', () => {
    const descriptors: PortalScriptDescriptor[] = [
      {
        name: 'Web — type check',
        scriptKey: 'workspace-repo:web:type-check',
        target: 'workspace-repo',
        repoId: 'web',
        repoName: 'Web',
      },
    ];

    const model = portalScriptsToSectionModel(descriptors, []);

    expect(model.entries).toEqual([
      {
        script: {
          scriptKey: 'workspace-repo:web:type-check',
          scriptName: 'type-check',
          label: 'Web — type check',
          displayName: 'Type Check',
          command: '',
          lifecycle: 'custom',
          target: 'workspace-repo',
          repoId: 'web',
          repoName: 'Web',
        },
        confirmBeforeRun: true,
        runDisabled: false,
      },
    ]);
  });

  it('preserves the frozen setup command and failed process result', () => {
    const model = portalScriptsToSectionModel(
      [
        {
          name: 'Setup',
          scriptName: 'setup',
          scriptKey: 'project:setup',
          target: 'project',
          command: 'npm ci\nnpm run build',
          lifecycle: 'setup',
        },
      ],
      [
        {
          name: 'Setup',
          scriptKey: 'project:setup',
          status: 'failed',
          exitCode: 17,
          outputTail: 'build failed',
          durationMs: 2500,
          timedOut: false,
          cancelable: false,
        },
      ],
    );

    expect(model.entries[0]?.script.command).toBe('npm ci\nnpm run build');
    expect(model.entries[0]?.script.lifecycle).toBe('setup');
    expect(model.entries[0]?.confirmBeforeRun).toBe(true);
    expect(model.runs['project:setup']).toMatchObject({
      status: 'failed',
      exitCode: 17,
      outputLines: ['build failed'],
      durationMs: 2500,
      timedOut: false,
      cancelable: false,
    });
  });

  it('keeps blocked setup visible without allowing a rerun', () => {
    const model = portalScriptsToSectionModel(
      [
        {
          ...descriptor('setup', 'project', 'project:setup'),
          runDisabled: true,
        },
      ],
      [],
    );

    expect(model.entries[0]?.runDisabled).toBe(true);
  });

  it('preserves a confirmed setup start refusal without an exit code', () => {
    const model = portalScriptsToSectionModel(
      [],
      [
        {
          name: 'Setup',
          scriptKey: 'project:setup',
          status: 'failed',
          startError: 'Setup configuration is invalid.',
        },
      ],
    );
    expect(model.runs['project:setup']).toMatchObject({
      exitCode: null,
      startError: 'Setup configuration is invalid.',
    });
  });

  it.each([
    ['running', 'running'],
    ['queued', 'running'],
    ['pending', 'running'],
    ['stopping', 'stopping'],
    ['completed', 'success'],
    ['success', 'success'],
    ['succeeded', 'success'],
    ['failed', 'failed'],
    ['cancelled', 'failed'],
    ['future-status', 'failed'],
  ])('maps portal status %s to body status %s', (portalStatus, bodyStatus) => {
    const runs: PortalScriptRunProjection[] = [
      {
        name: 'Build',
        scriptKey: 'build',
        status: portalStatus,
      },
    ];

    expect(portalScriptsToSectionModel([], runs).runs.build?.status).toBe(
      bodyStatus,
    );
  });

  it('maps output and timestamps, derives duration, and keeps only the latest run', () => {
    const runs: PortalScriptRunProjection[] = [
      {
        name: 'Old build',
        scriptKey: 'build',
        status: 'failed',
        startedAt: '2026-07-26T10:00:00.000Z',
      },
      {
        name: 'Build',
        scriptKey: 'build',
        status: 'completed',
        startedAt: '2026-07-26T11:00:00.000Z',
        finishedAt: '2026-07-26T11:00:02.500Z',
        outputTail: 'done',
      },
    ];

    const model = portalScriptsToSectionModel([], runs);

    expect(model.runs.build).toEqual({
      scriptKey: 'build',
      label: 'Build',
      status: 'success',
      outputLines: ['done'],
      exitCode: null,
      timedOut: false,
      durationMs: 2500,
      startedAt: Date.parse('2026-07-26T11:00:00.000Z'),
      hasDevServerHits: false,
    });
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0]?.runDisabled).toBe(true);
  });

  it('splits output tails into logical lines and handles absent output', () => {
    const runs: PortalScriptRunProjection[] = [
      {
        name: 'Multiline',
        scriptKey: 'multiline',
        status: 'completed',
        outputTail: 'one\ntwo',
      },
      {
        name: 'Absent',
        scriptKey: 'absent',
        status: 'completed',
      },
    ];

    const model = portalScriptsToSectionModel([], runs);

    expect(model.runs.multiline?.outputLines).toEqual(['one', 'two']);
    expect(model.runs.absent?.outputLines).toEqual([]);
  });

  it('uses zero duration for missing, invalid, or reversed timestamps', () => {
    const runs: PortalScriptRunProjection[] = [
      {
        name: 'Missing',
        scriptKey: 'missing',
        status: 'completed',
        startedAt: '2026-07-26T11:00:00.000Z',
      },
      {
        name: 'Invalid',
        scriptKey: 'invalid',
        status: 'completed',
        startedAt: 'invalid',
        finishedAt: 'also-invalid',
      },
      {
        name: 'Reversed',
        scriptKey: 'reversed',
        status: 'completed',
        startedAt: '2026-07-26T12:00:00.000Z',
        finishedAt: '2026-07-26T11:00:00.000Z',
      },
    ];

    const model = portalScriptsToSectionModel([], runs);

    expect(model.runs.missing?.durationMs).toBe(0);
    expect(model.runs.invalid?.durationMs).toBe(0);
    expect(model.runs.invalid?.startedAt).toBe(0);
    expect(model.runs.reversed?.durationMs).toBe(0);
  });

  it('orders an alphabetical lifecycle projection as setup, launch, teardown', () => {
    const descriptors = [
      descriptor('launch'),
      descriptor('setup'),
      descriptor('teardown'),
    ];

    const model = portalScriptsToSectionModel(descriptors, []);

    expect(model.entries.map((entry) => entry.script.scriptName)).toEqual([
      'setup',
      'launch',
      'teardown',
    ]);
  });

  it('orders alphabetical project lifecycle scripts as setup, launch, teardown', () => {
    const descriptors = [
      descriptor('launch', 'project', 'project:launch'),
      descriptor('setup', 'project', 'project:setup'),
      descriptor('teardown', 'project', 'project:teardown'),
    ];

    const model = portalScriptsToSectionModel(descriptors, []);

    expect(model.entries.map((entry) => entry.script.scriptName)).toEqual([
      'setup',
      'launch',
      'teardown',
    ]);
  });

  it('places lifecycle scripts first and preserves non-lifecycle projection order', () => {
    const descriptors = [
      descriptor('lint', 'project', 'lint'),
      descriptor('teardown'),
      descriptor('build', 'project', 'build'),
      descriptor('setup'),
      descriptor('test', 'project', 'test'),
      descriptor('launch'),
    ];

    const model = portalScriptsToSectionModel(descriptors, []);

    expect(model.entries.map((entry) => entry.script.scriptName)).toEqual([
      'setup',
      'launch',
      'teardown',
      'lint',
      'build',
      'test',
    ]);
  });

  it('leaves a single script unchanged', () => {
    const descriptors = [descriptor('build', 'project', 'build')];

    const model = portalScriptsToSectionModel(descriptors, []);

    expect(model.entries.map((entry) => entry.script.scriptName)).toEqual([
      'build',
    ]);
  });

  it('leaves no-lifecycle projection order unchanged', () => {
    const descriptors = [
      descriptor('test', 'project', 'test'),
      descriptor('build', 'project', 'build'),
      descriptor('lint', 'project', 'lint'),
    ];

    const model = portalScriptsToSectionModel(descriptors, []);

    expect(model.entries.map((entry) => entry.script.scriptName)).toEqual([
      'test',
      'build',
      'lint',
    ]);
  });
});
