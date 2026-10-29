import { normalizePipeline } from '../normalize-pipeline';
import type { Pipeline, ShellType } from '../../types/pipeline';

function buildPipeline(): Pipeline {
  return {
    name: 'Default Shell Test',
    on: 'dispatch',
    jobs: {
      build: {
        steps: [
          { id: 'step_with_shell', run: 'echo explicit', shell: 'node' },
          { id: 'step_without_shell', run: 'echo default' },
        ],
      },
    },
  };
}

describe('normalizePipeline default shell', () => {
  it.each<{ shell: ShellType }>([{ shell: 'pwsh' }, { shell: 'bash' }])(
    'uses $shell when defaultShell: "$shell" is provided',
    ({ shell }) => {
      const normalized = normalizePipeline(buildPipeline(), {
        defaultShell: shell,
      });

      expect(normalized.jobs.build.steps[0].shell).toBe('node');
      expect(normalized.jobs.build.steps[1].shell).toBe(shell);
    },
  );

  it('falls back to bash when options are omitted', () => {
    const normalized = normalizePipeline(buildPipeline());

    expect(normalized.jobs.build.steps[0].shell).toBe('node');
    expect(normalized.jobs.build.steps[1].shell).toBe('bash');
  });

  it('lets pipeline- and job-level run defaults override the provided default', () => {
    const normalized = normalizePipeline(
      {
        name: 'Defaults override',
        on: 'dispatch',
        jobs: {
          build: {
            defaults: {
              run: { shell: 'cmd' },
            },
            steps: [{ id: 'inherit', run: 'echo defaults' }],
          },
          plain: {
            steps: [{ id: 'no_defaults', run: 'echo plain' }],
          },
        },
      },
      { defaultShell: 'pwsh' },
    );

    // Job-level run defaults win over the injected default.
    expect(normalized.jobs.build.steps[0].shell).toBe('cmd');
    // Falls back to the injected default when nothing more specific is set.
    expect(normalized.jobs.plain.steps[0].shell).toBe('pwsh');
  });

  it('lets pipeline-level run defaults win over the injected default', () => {
    const normalized = normalizePipeline(
      {
        name: 'Pipeline default override',
        on: 'dispatch',
        defaults: {
          run: { shell: 'sh' },
        },
        jobs: {
          build: {
            steps: [{ id: 'inherit', run: 'echo pipeline' }],
          },
        },
      },
      { defaultShell: 'pwsh' },
    );

    expect(normalized.jobs.build.steps[0].shell).toBe('sh');
  });
});
