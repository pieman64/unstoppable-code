/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PipelinePackageAnalysisSummary,
  PipelinePackageManifestV1,
  PipelinePackageResource,
  PipelinePackageTree,
} from '@canopy/protocol/pipelines';
import {
  chooseSettingsOption,
  settingsSelectOptionValues,
  settingsSelectTrigger,
} from '../../../settings/__tests__/helpers/settings-select';
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

function emptyManifestWith(
  overrides: Partial<PipelinePackageManifestV1>,
): PipelinePackageManifestV1 {
  const manifest = emptyAnalysis.manifest;
  if (!manifest) throw new Error('Expected the empty package manifest');
  return { ...manifest, ...overrides };
}

function analysisWithManifest(
  analysis: PipelinePackageAnalysisSummary,
  overrides: Partial<PipelinePackageManifestV1>,
): PipelinePackageAnalysisSummary {
  const manifest = analysis.manifest;
  if (!manifest) throw new Error('Expected the analyzed package manifest');
  return { ...analysis, manifest: { ...manifest, ...overrides } };
}

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
  const helpTrigger = (): HTMLButtonElement | null =>
    container.querySelector<HTMLButtonElement>(
      '[data-testid="share-pipeline-dependencies-help"]',
    );
  const openHelp = (): string | null | undefined => {
    const trigger = helpTrigger();
    if (!trigger) throw new Error('help trigger missing');
    act(() => {
      trigger.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    return document.body.querySelector(
      '[data-testid="share-pipeline-dependencies-help-details"]',
    )?.textContent;
  };

  it('lists packaged pipelines, toggles a suggestion, and names withheld files', () => {
    const onTogglePipeline = jest.fn();
    const pipelineResource: PipelinePackageResource = {
      id: 'automation-pipeline-entry',
      kind: 'automation_pipeline',
      displayName: 'Entry',
      sourceLabel: 'local pipeline',
      sourceVisibility: 'local',
      invocationKeys: [],
      dependencyResourceIds: [],
      trees: [],
    };
    const analysis: PipelinePackageAnalysisSummary = {
      ...emptyAnalysis,
      manifest: emptyAnalysis.manifest && {
        ...emptyAnalysis.manifest,
        resources: [pipelineResource],
      },
      packagedPipelines: [
        {
          key: 'entry',
          resourceId: 'automation-pipeline-entry',
          name: 'Entry',
          pipelineContentHash: 'b'.repeat(64),
          source: 'user',
          isActionPipeline: false,
          optional: false,
          promptSpans: [],
        },
        {
          key: 'daily',
          resourceId: 'automation-pipeline-daily',
          name: 'Daily',
          pipelineContentHash: 'c'.repeat(64),
          source: 'user',
          isActionPipeline: false,
          optional: true,
          promptSpans: [],
        },
      ],
      withheldFiles: [
        {
          pipelineKey: 'entry',
          assetId: 'specialists',
          relativePath: '.env',
          reason: 'denied_name',
        },
      ],
    };
    act(() => {
      root.render(
        <CapabilityPackageDependencies
          analysis={analysis}
          loading={false}
          errored={false}
          selectedOptionalResourceIds={[]}
          onToggleOptionalResource={() => {}}
          selectedPipelineKeys={[]}
          onTogglePipeline={onTogglePipeline}
          onRetry={() => {}}
          disabled={false}
          testIdPrefix="share-automation"
        />,
      );
    });
    const required = container.querySelector(
      '[data-testid="share-automation-dependencies-pipeline-entry"]',
    );
    expect(required?.getAttribute('data-required')).toBe('true');
    expect(required?.getAttribute('data-included')).toBe('true');
    expect(required?.querySelector('input')).toBeNull();
    const suggestion = container.querySelector<HTMLInputElement>(
      '[data-testid="share-automation-dependencies-pipeline-toggle-daily"]',
    );
    expect(suggestion?.checked).toBe(false);
    act(() => {
      suggestion?.click();
    });
    expect(onTogglePipeline).toHaveBeenCalledWith('daily');
    expect(
      container.querySelector(
        '[data-testid="share-automation-dependencies-summary"]',
      )?.textContent,
    ).toContain('1 pipeline');
    expect(
      container.querySelector(
        '[data-testid="share-automation-dependencies-summary"]',
      )?.textContent,
    ).not.toContain('Definition only');
    // Required pipelines do not create an optional-file disclosure, and
    // withheld files remain visible without opening one.
    expect(
      container.querySelector(
        '[data-testid="share-automation-dependencies-toggle"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="share-automation-dependencies-item-automation-pipeline-entry"]',
      ),
    ).toBeNull();
    const withheld = container.querySelector(
      '[data-testid="share-automation-dependencies-withheld-item"]',
    );
    expect(withheld?.textContent).toContain('specialists/.env');
    expect(withheld?.textContent).toContain('Credential file');
  });

  it('offers pipelines to add, leaving out ones the share already carries, and shows a failed add', async () => {
    const onAdd = jest
      .fn<Promise<void>, [string]>()
      .mockRejectedValueOnce(new Error('Could not save the pipeline list.'))
      .mockResolvedValue(undefined);
    const analysis: PipelinePackageAnalysisSummary = {
      ...emptyAnalysis,
      packagedPipelines: [
        {
          key: 'entry',
          resourceId: 'automation-pipeline-entry',
          name: 'Entry',
          pipelineContentHash: 'b'.repeat(64),
          source: 'user',
          isActionPipeline: false,
          optional: false,
          promptSpans: [],
        },
        {
          key: 'daily',
          resourceId: 'automation-pipeline-daily',
          name: 'Daily',
          pipelineContentHash: 'c'.repeat(64),
          source: 'user',
          isActionPipeline: false,
          optional: true,
          promptSpans: [],
        },
      ],
    };
    act(() => {
      root.render(
        <CapabilityPackageDependencies
          analysis={analysis}
          loading={false}
          errored={false}
          selectedOptionalResourceIds={[]}
          onToggleOptionalResource={() => {}}
          selectedPipelineKeys={[]}
          pipelineAdd={{
            options: [
              { id: 'entry', key: 'entry', name: 'Entry' },
              { id: 'daily', key: 'daily', name: 'Daily' },
              { id: 'worker', key: 'worker', name: 'Worker' },
            ],
            onAdd,
          }}
          onRetry={() => {}}
          disabled={false}
          testIdPrefix="share-automation"
        />,
      );
    });
    const select = settingsSelectTrigger(
      container,
      '[data-testid="share-automation-dependencies-pipeline-add"]',
    );
    // A required pipeline is in the share; an unticked suggestion is not.
    expect(settingsSelectOptionValues(select)).toEqual(['daily', 'worker']);
    const choose = (value: string): Promise<void> =>
      chooseSettingsOption(select, value);
    await choose('worker');
    expect(onAdd).toHaveBeenCalledWith('worker');
    expect(
      container.querySelector(
        '[data-testid="share-automation-dependencies-pipeline-add-error"]',
      )?.textContent,
    ).toBe('Could not save the pipeline list.');
    await choose('worker');
    expect(
      container.querySelector(
        '[data-testid="share-automation-dependencies-pipeline-add-error"]',
      ),
    ).toBeNull();
  });

  it('shows the Pipelines group with only the add control when nothing is packaged yet', () => {
    act(() => {
      root.render(
        <CapabilityPackageDependencies
          analysis={emptyAnalysis}
          loading={false}
          errored={false}
          selectedOptionalResourceIds={[]}
          onToggleOptionalResource={() => {}}
          pipelineAdd={{
            options: [{ id: 'worker', key: 'worker', name: 'Worker' }],
            onAdd: () => Promise.resolve(),
          }}
          onRetry={() => {}}
          disabled={false}
          testIdPrefix="share-automation"
        />,
      );
    });
    expect(
      container.querySelector(
        '[data-testid="share-automation-dependencies-pipelines"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="share-automation-dependencies-pipeline-add"]',
      ),
    ).not.toBeNull();
  });

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
            manifest: emptyManifestWith({
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
            }),
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
    expect(openHelp()).toContain('Runnable scripts: scripts/zip.sh.');
  });

  it('opens the included files help on a click or tap, not only on hover', () => {
    act(() => {
      root.render(
        <CapabilityPackageDependencies
          analysis={emptyAnalysis}
          loading={false}
          errored={false}
          selectedOptionalResourceIds={[]}
          onToggleOptionalResource={() => {}}
          onRetry={() => {}}
          subjectLabel="skill"
          disabled={false}
          testIdPrefix="share-pipeline"
        />,
      );
    });
    const details = (): Element | null =>
      document.body.querySelector(
        '[data-testid="share-pipeline-dependencies-help-details"]',
      );
    expect(details()).toBeNull();

    // Touch has no hover, and the help is where a publisher learns what a
    // share copies, so activating the icon must show it too.
    act(() => {
      helpTrigger()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(details()?.textContent).toContain(
      'Only the skill definition is shared.',
    );
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
            manifest: emptyManifestWith({
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
            }),
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
    // One skill, one name: the Codex copy is the same folder, and its
    // generated invocation name means nothing to a publisher.
    const details = openHelp();
    expect(details).toContain('Copied into this share: /deploy.');
    expect(details).not.toContain('$builtin-app-plugin');
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
      manifest: emptyManifestWith({
        resources: [
          resource('required', 'local', 1024),
          resource('optional', 'private', 2048),
        ],
        bindings: [{ target: 'subject', resourceIds: [...boundIds] }],
        environmentRequirements: Array.from(
          { length: requirementCount },
          (_, index) => ({
            id: `req-${String(index)}`,
            kind: 'mcp' as const,
            displayName: `Server ${String(index)}`,
            required: true,
            setupHint: 'Connect it.',
            affectedSteps: [],
          }),
        ),
        totalFiles: 2,
        totalBytes: 3072,
      }),
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

    describe('included files help', () => {
      it('replaces Show details with a help icon right after the value', () => {
        renderReview(emptyAnalysis, []);
        expect(container.textContent).not.toContain('Show details');
        expect(toggle()).toBeNull();
        expect(helpTrigger()?.getAttribute('aria-label')).toBe(
          'About included files',
        );
        // The icon follows the value text inside the summary row.
        expect(
          helpTrigger()?.closest(
            '[data-testid="share-pipeline-dependencies-summary"]',
          ),
        ).not.toBeNull();
        expect(helpTrigger()?.closest('div')?.textContent).toContain(
          'Definition only',
        );
        const details = openHelp();
        expect(details).toContain('Only the skill definition is shared.');
        expect(details).toContain(
          'Credentials, private configuration, and local files are never included.',
        );
      });

      it('summarizes a long file list and the recipient setup in the tooltip', () => {
        const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        renderReview(
          analysisWithManifest(analysisWith(ids, 2), {
            resources: ids.map((id) =>
              resource(id, id === 'b' ? 'private' : 'local', 10),
            ),
          }),
          [],
        );
        const details = openHelp();
        expect(details).toContain(
          'Copied into this share: a, b, c, d, e, and 3 more.',
        );
        expect(details).not.toContain('f, ');
        expect(details).toContain('From private sources: b.');
        expect(details).toContain('Recipients set up: Server 0, Server 1.');
        expect(details).toContain(
          'Credentials, private configuration, and other local files are never included.',
        );
      });

      it('keeps a Choose files disclosure only when there are optional files', () => {
        renderReview(analysisWith(['required']), []);
        expect(toggle()?.textContent).toBe('Choose files');
        expand();
        expect(toggle()?.textContent).toBe('Hide files');
        expect(
          container.querySelector('input[aria-label="Include optional"]'),
        ).not.toBeNull();

        renderReview(
          analysisWithManifest(analysisWith(['required']), {
            resources: [resource('required', 'local', 10)],
          }),
          [],
        );
        expect(toggle()).toBeNull();
      });
    });
  });
});
