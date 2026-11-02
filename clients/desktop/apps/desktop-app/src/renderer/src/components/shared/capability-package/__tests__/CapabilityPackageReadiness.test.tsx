/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PipelinePackageReadiness } from '@canopy/desktop-shared/types/pipeline';
import { CapabilityPackageReadiness } from '../CapabilityPackageReadiness';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('CapabilityPackageReadiness', () => {
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

  it('names the default subject a workflow in the setup and definition-only notes', () => {
    const readiness: PipelinePackageReadiness = {
      status: 'invalid',
      distributionMode: 'definition_only',
      requirements: [],
    };

    act(() => {
      root.render(<CapabilityPackageReadiness readiness={readiness} />);
    });

    expect(container.textContent).toContain(
      'This workflow needs the following on this machine before it can run.',
    );
    expect(container.textContent).toContain(
      'This workflow’s packaged dependencies could not be verified.',
    );
    expect(
      container.querySelector(
        '[data-testid="pipeline-trigger-modal-definition-only-note"]',
      )?.textContent,
    ).toBe(
      'This workflow was installed from a definition-only share, so its required dependencies are not included.',
    );
    expect(container.textContent).not.toMatch(/pipeline/i);
  });

  it('shows non-blocking publisher notes even when setup is already ready', () => {
    const readiness: PipelinePackageReadiness = {
      status: 'ready',
      distributionMode: 'package',
      requirements: [],
      publisherNotes: [
        {
          id: 'not-a-command-collect-py',
          kind: 'not_a_command',
          label: '/collect.py',
          affectedSteps: [{ jobId: 'review', stepId: 'collect' }],
        },
      ],
    };

    act(() => {
      root.render(<CapabilityPackageReadiness readiness={readiness} />);
    });

    const notes = container.querySelector(
      '[data-testid="pipeline-package-publisher-notes"]',
    );
    expect(notes?.textContent).toContain('Not included');
    expect(notes?.textContent).toContain(
      'The publisher marked these as not commands, so they are not copied.',
    );
    expect(notes?.textContent).toContain('/collect.py');
    expect(notes?.textContent).toContain('review.collect');
    expect(container.textContent).not.toContain(
      'This workflow needs the following on this machine before it can run.',
    );
  });
});
