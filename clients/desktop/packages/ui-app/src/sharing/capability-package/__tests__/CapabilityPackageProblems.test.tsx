/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PipelinePackageAnalysisBlocker } from '@canopy/protocol/pipelines';
import { CapabilityPackageProblems } from '../CapabilityPackageProblems';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const unresolved = (token: string): PipelinePackageAnalysisBlocker => ({
  code: 'UNRESOLVED_INVOCATION',
  subject: token,
  message: `${token} could not be resolved.`,
  occurrences: [{ jobId: 'build', stepId: 'run' }],
  dismissal: { provider: 'claude', token },
});

const secret: PipelinePackageAnalysisBlocker = {
  code: 'SUSPECTED_SECRET',
  subject: 'deploy/.env',
  message: 'A dependency file may contain a credential.',
  relativePath: 'deploy/.env',
  occurrences: [],
};

describe('CapabilityPackageProblems', () => {
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

  const byTestId = (id: string): HTMLElement | null =>
    container.querySelector(`[data-testid="${id}"]`);
  const buttonLabels = (): Array<string | null> =>
    Array.from(container.querySelectorAll('button')).map(
      (button) => button.textContent,
    );

  it('dismisses an ambiguous pipeline name from its own sentence', () => {
    const onDismissReference = jest.fn();
    act(() => {
      root.render(
        <CapabilityPackageProblems
          blockers={[
            {
              code: 'AMBIGUOUS_PIPELINE_REFERENCE',
              subject: 'Daily',
              message: 'Daily matches more than one pipeline.',
              occurrences: [],
              referenceDismissal: {
                kind: 'pipeline_reference',
                token: 'Daily',
              },
            },
          ]}
          onDismissReference={onDismissReference}
          disabled={false}
          testIdPrefix="share-automation"
        />,
      );
    });
    const item = byTestId(
      'share-automation-dependency-problems-item-ambiguous-pipeline-reference-daily',
    );
    expect(item?.getAttribute('data-dismissible')).toBe('true');
    const link = byTestId(
      'share-automation-dependency-problems-dismiss-ambiguous-pipeline-reference-daily',
    );
    expect(link?.textContent).toBe('mark it as not a pipeline');
    expect(link?.getAttribute('aria-label')).toBe(
      'Mark Daily as not a pipeline',
    );
    act(() => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDismissReference).toHaveBeenCalledWith({
      kind: 'pipeline_reference',
      token: 'Daily',
    });
  });

  it('lists left-out pipeline mentions with an undo', () => {
    const onRestoreReference = jest.fn();
    act(() => {
      root.render(
        <CapabilityPackageProblems
          blockers={[]}
          dismissedReferences={[
            { kind: 'child_pipeline_ref', token: '${{ inputs.target }}' },
          ]}
          onRestoreReference={onRestoreReference}
          disabled={false}
          testIdPrefix="share-automation"
        />,
      );
    });
    expect(
      byTestId('share-automation-dependency-problems-notice')?.textContent,
    ).toContain('1 pipeline mention left out.');
    const list = byTestId(
      'share-automation-dependency-problems-dismissed-references',
    );
    act(() => {
      list
        ?.querySelector('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const undo = byTestId(
      'share-automation-dependency-problems-dismissed-reference-undo-child-inputs-target',
    );
    act(() => {
      undo?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRestoreReference).toHaveBeenCalledWith({
      kind: 'child_pipeline_ref',
      token: '${{ inputs.target }}',
    });
  });

  it('makes a single problem the headline, with one button', () => {
    const onDismiss = jest.fn();
    act(() => {
      root.render(
        <CapabilityPackageProblems
          blockers={[unresolved('/repair-diffs')]}
          dismissedInvocations={[]}
          onDismiss={onDismiss}
          onRestore={() => {}}
          onFixWithAI={() => {}}
          disabled={false}
          testIdPrefix="share-skill"
        />,
      );
    });

    const notice = byTestId('share-skill-dependency-problems-notice');
    expect(notice?.textContent).toContain('/repair-diffs was not found.');
    expect(notice?.textContent).toContain(
      'Install it, or mark it as not a command if the prompt only mentions it.',
    );
    // No count headline repeats the problem, and no generic instructions.
    expect(container.textContent).not.toContain('problem blocks');
    expect(container.textContent).not.toContain('Fix them');
    expect(buttonLabels()).not.toContain('Recheck dependencies');
    expect(buttonLabels()).not.toContain('Not a command');
    expect(
      byTestId('share-skill-dependency-problems-fix-with-ai')?.textContent,
    ).toBe('Fix it with AI');
    expect(
      byTestId(
        'share-skill-dependency-problems-item-unresolved-invocation-repair-diffs',
      )?.dataset.code,
    ).toBe('UNRESOLVED_INVOCATION');

    const dismiss = byTestId(
      'share-skill-dependency-problems-dismiss-unresolved-invocation-repair-diffs',
    );
    expect(dismiss?.textContent).toBe('mark it as not a command');
    expect(dismiss?.getAttribute('aria-label')).toBe(
      'Mark /repair-diffs as not a command',
    );
    act(() => {
      dismiss?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onDismiss).toHaveBeenCalledWith({
      provider: 'claude',
      token: '/repair-diffs',
    });
  });

  it('heads several problems with a count and one Fix it with AI', () => {
    act(() => {
      root.render(
        <CapabilityPackageProblems
          blockers={[unresolved('/repair-diffs'), secret, unresolved('/lint')]}
          dismissedInvocations={[]}
          onDismiss={() => {}}
          onRestore={() => {}}
          onFixWithAI={() => {}}
          disabled={false}
          testIdPrefix="share-pipeline"
        />,
      );
    });

    expect(
      byTestId('share-pipeline-dependency-problems-notice')?.textContent,
    ).toContain('3 problems block this share');
    expect(
      buttonLabels().filter((label) => label === 'Fix it with AI'),
    ).toHaveLength(1);
    const rows = Array.from(
      container.querySelectorAll(
        '[data-testid^="share-pipeline-dependency-problems-item-"]',
      ),
    );
    // Security findings lead.
    expect(rows.map((row) => row.getAttribute('data-code'))).toEqual([
      'SUSPECTED_SECRET',
      'UNRESOLVED_INVOCATION',
      'UNRESOLVED_INVOCATION',
    ]);
    // Only a dismissible row carries the inline link.
    expect(rows[0]?.querySelector('[aria-label^="Mark "]')).toBeNull();
    expect(rows[1]?.querySelector('[aria-label^="Mark "]')).not.toBeNull();
    expect(
      byTestId(
        'share-pipeline-dependency-problems-steps-unresolved-invocation-lint',
      )?.textContent,
    ).toBe('Used in 1 step');
  });

  it('renders no Fix it with AI without a host handler', () => {
    act(() => {
      root.render(
        <CapabilityPackageProblems
          blockers={[secret]}
          disabled={false}
          testIdPrefix="share-skill"
        />,
      );
    });

    expect(byTestId('share-skill-dependency-problems-fix-with-ai')).toBeNull();
    expect(container.querySelector('button[aria-label^="Mark "]')).toBeNull();
    expect(buttonLabels()).toEqual(['Details']);
  });
});
