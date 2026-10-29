/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PipelinePackageAnalysisSummary } from '@canopy/protocol/pipelines';
import type {
  PipelinePackageResource,
  PipelinePackageTree,
} from '@canopy/protocol/pipelines';
import { CapabilityPackageDependencies } from '../CapabilityPackageDependencies';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const emptyAnalysis: PipelinePackageAnalysisSummary = {
  analysisId: 'empty-analysis',
  state: 'ready',
  pipelineContentHash: 'a'.repeat(64),
  blockers: [],
  expiresAt: '2099-01-01T00:00:00.000Z',
  manifest: {
    version: 1,
    pipelineContentHash: 'a'.repeat(64),
    resources: [],
    bindings: [],
    environmentRequirements: [],
    totalFiles: 0,
    totalBytes: 0,
  },
};

describe('CapabilityPackageDependencies', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const toggle = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(
      '[data-testid="share-pipeline-dependencies-toggle"]',
    );
  const summaryText = (): string | null | undefined =>
    container.querySelector(
      '[data-testid="share-pipeline-dependencies-summary"]',
    )?.textContent;
  const expand = (): void => {
    act(() => {
      toggle()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  it('shows the failure reason beneath the generic analysis failure', () => {
    act(() => {
      root.render(
        <CapabilityPackageDependencies
          analysis={null}
          loading={false}
          errored
          errorReason="Model lookup failed for step build."
          selectedOptionalResourceIds={[]}
          onToggleOptionalResource={() => {}}
          onRetry={() => {}}
          disabled={false}
          testIdPrefix="share-pipeline"
        />,
      );
    });

    // The reason sits in the same alert region, so it is announced too.
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't check the included files. Try again." +
        'Details: Model lookup failed for step build.',
    );
    expect(
      container.querySelector(
        '[data-testid="share-pipeline-dependencies-retry"]',
      )?.textContent,
    ).toBe('Try again');
    expect(
      container.querySelector(
        '[data-testid="share-pipeline-dependencies-error-reason"]',
      )?.textContent,
    ).toBe('Details: Model lookup failed for step build.');
  });

  it('shortens a long failure reason and keeps the full text in its title', () => {
    const longReason = `Analysis failed: ${'x'.repeat(400)}`;
    act(() => {
      root.render(
        <CapabilityPackageDependencies
          analysis={null}
          loading={false}
          errored
          errorReason={longReason}
          selectedOptionalResourceIds={[]}
          onToggleOptionalResource={() => {}}
          onRetry={() => {}}
          disabled={false}
          testIdPrefix="share-pipeline"
        />,
      );
    });

    const reason = container.querySelector(
      '[data-testid="share-pipeline-dependencies-error-reason"]',
    );
    expect(reason?.textContent?.length).toBeLessThanOrEqual(
      'Details: '.length + 240,
    );
    expect(reason?.textContent?.endsWith('…')).toBe(true);
    expect(reason?.getAttribute('title')).toBe(longReason);
  });

  it('omits the reason line when the failure has no reason', () => {
    act(() => {
      root.render(
        <CapabilityPackageDependencies
          analysis={null}
          loading={false}
          errored
          selectedOptionalResourceIds={[]}
          onToggleOptionalResource={() => {}}
          onRetry={() => {}}
          disabled={false}
          testIdPrefix="share-pipeline"
        />,
      );
    });

    expect(
      container.querySelector(
        '[data-testid="share-pipeline-dependencies-error-reason"]',
      ),
    ).toBeNull();
  });

  it('keeps the publisher empty state silent while revalidating', () => {
    act(() => {
      root.render(
        <CapabilityPackageDependencies
          analysis={emptyAnalysis}
          loading
          errored={false}
          selectedOptionalResourceIds={[]}
          onToggleOptionalResource={() => {}}
          onRetry={() => {}}
          dismissedInvocations={[]}
          onDismissInvocation={() => {}}
          onRestoreInvocation={() => {}}
          disabled={false}
          testIdPrefix="share-pipeline"
        />,
      );
    });

    expect(
      container.querySelector(
        '[data-testid="share-pipeline-dependencies-revalidating"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="share-pipeline-dependencies-empty"]',
      ),
    ).toBeNull();
  });

  it('offers no Recheck button beside blocking problems', () => {
    act(() => {
      root.render(
        <CapabilityPackageDependencies
          analysis={{
            ...emptyAnalysis,
            state: 'blocked',
            blockers: [
              {
                code: 'EXPORT_DENIED_FILE',
                subject: '.git/config',
                message: 'A dependency file cannot be exported.',
                relativePath: '.git/config',
                occurrences: [],
              },
            ],
          }}
          loading={false}
          errored={false}
          selectedOptionalResourceIds={[]}
          onToggleOptionalResource={() => {}}
          onRetry={() => {}}
          dismissedInvocations={[]}
          onDismissInvocation={() => {}}
          onRestoreInvocation={() => {}}
          disabled={false}
          testIdPrefix="share-pipeline"
        />,
      );
    });

    expect(container.textContent).toContain(".git/config can't be shared");
    expect(
      Array.from(container.querySelectorAll('button')).map(
        (button) => button.textContent,
      ),
    ).not.toContain('Recheck dependencies');
  });

  it('names runnable scripts on their own line', () => {
    const entry = {
      sha256: 'c'.repeat(64),
      size: 10,
    };
    act(() => {
      root.render(
        <CapabilityPackageDependencies
          analysis={{
            ...emptyAnalysis,
            manifest: {
              ...emptyAnalysis.manifest,
              resources: [
                {
                  id: 'deploy',
                  kind: 'standalone_skill',
                  displayName: 'Deploy',
                  sourceLabel: 'local',
                  sourceVisibility: 'local',
                  invocationKeys: ['/deploy'],
                  dependencyResourceIds: [],
                  trees: [
                    {
                      provider: 'claude',
                      runtimeKind: 'standalone_skill',
                      rootName: 'deploy',
                      entries: [
                        { ...entry, path: 'SKILL.md', mode: 'read' },
                        { ...entry, path: 'scripts/zip.sh', mode: 'execute' },
                      ],
                    },
                  ],
                },
              ],
              bindings: [{ target: 'subject', resourceIds: ['deploy'] }],
              totalFiles: 2,
              totalBytes: 20,
            },
          }}
          loading={false}
          errored={false}
          selectedOptionalResourceIds={[]}
          onToggleOptionalResource={() => {}}
          onRetry={() => {}}
          dismissedInvocations={[]}
          onDismissInvocation={() => {}}
          onRestoreInvocation={() => {}}
          subjectLabel="skill"
          disabled={false}
          testIdPrefix="share-pipeline"
        />,
      );
    });

    // A file count alone would hide that the share runs code. The publisher
    // sees exactly what the recipient will be told.
    expand();
    expect(
      container.querySelector(
        '[data-testid="capability-package-executable-files"]',
      )?.textContent,
    ).toBe('Runnable scripts: scripts/zip.sh');
  });

  it('shows a skill packaged for both providers as one row', () => {
    const tree = (provider: 'claude' | 'codex'): PipelinePackageTree => ({
      provider,
      runtimeKind: 'standalone_skill' as const,
      rootName: 'deploy',
      entries: [
        {
          path: 'SKILL.md',
          sha256: 'c'.repeat(64),
          size: 10,
          mode: 'read' as const,
        },
      ],
    });
    act(() => {
      root.render(
        <CapabilityPackageDependencies
          analysis={{
            ...emptyAnalysis,
            manifest: {
              ...emptyAnalysis.manifest,
              resources: [
                {
                  id: 'deploy-claude',
                  kind: 'standalone_skill',
                  displayName: '/deploy',
                  sourceLabel: 'Custom',
                  sourceVisibility: 'local',
                  invocationKeys: ['/deploy'],
                  dependencyResourceIds: [],
                  trees: [tree('claude')],
                },
                {
                  id: 'deploy-codex',
                  kind: 'standalone_skill',
                  displayName: '$builtin-app-plugin:deploy',
                  sourceLabel: 'Custom',
                  sourceVisibility: 'local',
                  invocationKeys: ['$builtin-app-plugin:deploy'],
                  dependencyResourceIds: [],
                  trees: [tree('codex')],
                },
              ],
              bindings: [
                {
                  target: 'subject',
                  resourceIds: ['deploy-claude', 'deploy-codex'],
                },
              ],
              totalFiles: 2,
              totalBytes: 20,
            },
          }}
          loading={false}
          errored={false}
          selectedOptionalResourceIds={[]}
          onToggleOptionalResource={() => {}}
          onRetry={() => {}}
          dismissedInvocations={[]}
          onDismissInvocation={() => {}}
          onRestoreInvocation={() => {}}
          subjectLabel="skill"
          disabled={false}
          testIdPrefix="share-pipeline"
        />,
      );
    });

    // Twins are one folder, so the summary counts its file once.
    expect(summaryText()).toContain('1 file · ');
    expand();
    const rows = container.querySelectorAll(
      '[data-testid="share-pipeline-dependencies-list"] > li',
    );
    // One skill, one row: the Codex copy is the same folder, and its
    // generated invocation name means nothing to a publisher.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('/deploy');
    expect(rows[0]?.textContent).not.toContain('$builtin-app-plugin');
    expect(rows[0]?.textContent).toContain('1 file');
  });

  describe('collapsed review', () => {
    const fileEntry = (
      path: string,
      size: number,
    ): PipelinePackageTree['entries'][number] => ({
      path,
      sha256: path.padEnd(64, 'f').slice(0, 64),
      size,
      mode: 'read' as const,
    });
    const resource = (
      id: string,
      visibility: 'public' | 'private' | 'local',
      size: number,
    ): PipelinePackageResource => ({
      id,
      kind: 'standalone_skill' as const,
      displayName: id,
      sourceLabel: 'Custom',
      sourceVisibility: visibility,
      invocationKeys: [`/${id}`],
      dependencyResourceIds: [],
      trees: [
        {
          provider: 'claude' as const,
          runtimeKind: 'standalone_skill' as const,
          rootName: id,
          entries: [fileEntry(`${id}/SKILL.md`, size)],
        },
      ],
    });
    const analysisWith = (
      boundIds: readonly string[],
      requirementCount = 0,
    ): PipelinePackageAnalysisSummary => ({
      ...emptyAnalysis,
      manifest: {
        ...emptyAnalysis.manifest,
        resources: [
          resource('required', 'local', 1024),
          resource('optional', 'private', 2048),
        ],
        bindings: [{ target: 'subject', resourceIds: [...boundIds] }],
        environmentRequirements: Array.from(
          { length: requirementCount },
          (_, index) => ({
            id: `req-${String(index)}`,
            kind: 'mcp_server' as const,
            displayName: `Server ${String(index)}`,
            required: true,
            setupHint: 'Connect it.',
            affectedSteps: [],
          }),
        ),
        totalFiles: 2,
        totalBytes: 3072,
      },
    });
    const renderReview = (
      analysis: PipelinePackageAnalysisSummary,
      selected: readonly string[],
      onToggle: (id: string) => void = () => {},
      mode: 'package' | 'reference' = 'package',
    ): void => {
      act(() => {
        root.render(
          <CapabilityPackageDependencies
            analysis={analysis}
            loading={false}
            errored={false}
            selectedOptionalResourceIds={selected}
            onToggleOptionalResource={onToggle}
            onRetry={() => {}}
            mode={mode}
            subjectLabel="skill"
            disabled={false}
            testIdPrefix="share-pipeline"
          />,
        );
      });
    };

    it('starts collapsed with an accurate summary of the selected files', () => {
      renderReview(analysisWith(['required'], 2), []);
      expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
      const controls = toggle()?.getAttribute('aria-controls');
      expect(controls).toBeTruthy();
      expect(
        container
          .querySelector(`[id="${controls ?? ''}"]`)
          ?.hasAttribute('hidden'),
      ).toBe(true);
      expect(summaryText()).toContain('Included files');
      expect(summaryText()).toContain('1 file · ');
      expect(summaryText()).toContain('2 setup requirements');
      expect(
        container.querySelector(
          '[data-testid="share-pipeline-dependencies-list"]',
        ),
      ).toBeNull();
    });

    it('updates the summary for a selected optional file while collapsed', () => {
      const onToggle = jest.fn();
      renderReview(analysisWith(['required']), [], onToggle);
      expand();
      expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
      const optional = container.querySelector<HTMLInputElement>(
        'input[aria-label="Include optional"]',
      );
      act(() => {
        optional?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(onToggle).toHaveBeenCalledWith('optional');
      expand();
      renderReview(analysisWith(['required']), ['optional'], onToggle);
      expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
      expect(summaryText()).toContain('2 files · ');
    });

    it('shows Required text instead of a checkbox for a required file', () => {
      renderReview(analysisWith(['required']), []);
      expand();
      const required = container.querySelector(
        '[data-testid="share-pipeline-dependencies-item-required"]',
      );
      expect(required?.querySelector('input')).toBeNull();
      expect(required?.textContent).toContain('Required');
      expect(
        container
          .querySelector(
            '[data-testid="share-pipeline-dependencies-item-optional"]',
          )
          ?.querySelector('input[type="checkbox"]'),
      ).not.toBeNull();
    });

    it('reads Definition only when nothing is copied, never 0 files', () => {
      renderReview(analysisWith([], 1), []);
      expect(summaryText()).toContain('Definition only');
      expect(summaryText()).toContain('1 setup requirement');
      expect(summaryText()).not.toContain('0 files');

      renderReview(analysisWith(['required'], 1), [], () => {}, 'reference');
      expect(summaryText()).toContain('Definition only');
    });

    it('keeps blockers visible while collapsed, without a second count', () => {
      renderReview(
        {
          ...analysisWith(['required']),
          state: 'blocked',
          blockers: [
            {
              code: 'EXPORT_DENIED_FILE',
              subject: '.git/config',
              message: 'A dependency file cannot be exported.',
              relativePath: '.git/config',
              occurrences: [],
            },
          ],
        },
        [],
      );
      expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
      expect(summaryText()).not.toContain('attention');
      expect(container.textContent).toContain('.git/config');
    });

    it('keeps the disclosure open across a re-analysis', () => {
      renderReview(analysisWith(['required']), []);
      expand();
      act(() => {
        root.render(
          <CapabilityPackageDependencies
            analysis={analysisWith(['required'])}
            loading
            errored={false}
            selectedOptionalResourceIds={[]}
            onToggleOptionalResource={() => {}}
            onRetry={() => {}}
            disabled={false}
            testIdPrefix="share-pipeline"
          />,
        );
      });
      renderReview(analysisWith(['required']), []);
      expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    });
  });
});
