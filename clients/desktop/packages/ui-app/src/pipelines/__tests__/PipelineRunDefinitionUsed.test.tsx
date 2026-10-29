/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PortalPipelineDefinitionViewModel } from '@canopy/protocol/portal';
import { PipelineRunDefinitionUsed } from '../PipelineRunDefinitionUsed';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const definition: PortalPipelineDefinitionViewModel = {
  name: 'Ship ticket',
  triggerSummary: '',
  scopes: ['worktree'],
  jobs: [
    {
      id: 'plan',
      name: 'Plan',
      dependencies: [],
      steps: [
        {
          id: 'draft',
          name: 'Draft the plan',
          kind: 'action',
          usesSummary: 'builtin/agent-prompt',
        },
      ],
    },
  ],
  canonicalYaml: 'pipeline:\n  name: Ship ticket\n',
};

describe('PipelineRunDefinitionUsed', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function byTestId(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  it('shows the recorded definition read-only', () => {
    act(() =>
      root.render(<PipelineRunDefinitionUsed definition={definition} />),
    );
    const section = byTestId('pipeline-run-definition-used');
    expect(section?.getAttribute('aria-label')).toBe('Definition used');
    expect(byTestId('pipeline-read-detail')).not.toBeNull();
    expect(section?.textContent).toContain('Ship ticket');
    expect(section?.textContent).toContain('Draft the plan');
    // Read-only: nothing here opens the editor.
    expect(byTestId('pipeline-read-detail-open-editor')).toBeNull();
    expect(byTestId('pipeline-run-definition-used-not-recorded')).toBeNull();
    // The snapshot keeps no triggers, so no empty trigger pill is drawn.
    expect(
      byTestId('pipeline-read-detail-meta')?.querySelector('.bg-info-subtle'),
    ).toBeNull();
  });

  it('says the definition was not recorded when the run has none', () => {
    act(() => root.render(<PipelineRunDefinitionUsed definition={null} />));
    expect(
      byTestId('pipeline-run-definition-used-not-recorded')?.textContent,
    ).toBe('Not recorded');
    expect(byTestId('pipeline-read-detail')).toBeNull();
  });
});
