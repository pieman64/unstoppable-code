/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PortalPipelineDefinitionViewModel } from '@canopy/protocol/portal';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { PipelineReadDetail } from '../PipelineReadDetail';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const definition: PortalPipelineDefinitionViewModel = {
  name: 'Release train',
  description: 'Build and publish the release.',
  version: '2.1',
  icon: '🚂',
  triggerSummary: 'Manual, Plan ready',
  scopes: ['directory', 'worktree'],
  jobs: [
    {
      id: 'build',
      name: 'Build',
      dependencies: [],
      steps: [
        {
          id: 'checkout',
          name: 'Checkout',
          kind: 'action',
          usesSummary: 'actions/checkout',
        },
        { id: 'test', name: 'Test', kind: 'script', usesSummary: 'npm test' },
      ],
    },
    {
      id: 'publish',
      name: 'Publish',
      dependencies: ['build'],
      steps: [
        {
          id: 'publish-1',
          name: 'Publish package',
          kind: 'script',
          usesSummary: 'npm publish',
        },
      ],
    },
  ],
  canonicalYaml: 'pipeline:\n  name: Release train\n',
};

function mount(onOpenEditor?: () => void): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() =>
    root.render(
      <PipelineReadDetail
        definition={definition}
        onOpenEditor={onOpenEditor}
      />,
    ),
  );
  return { container, root };
}

describe('PipelineReadDetail', () => {
  it('renders metadata and preserves job and step order', () => {
    const { container, root } = mount();
    expect(
      container.querySelector('[data-testid="pipeline-read-detail"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="pipeline-read-detail-meta"]')
        ?.textContent,
    ).toContain('Manual, Plan ready');
    const jobs = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="pipeline-read-detail-job"]',
      ),
    );
    expect(jobs.map((job) => job.textContent)).toEqual([
      expect.stringContaining('Build'),
      expect.stringContaining('Publish'),
    ]);
    const steps = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="pipeline-read-detail-step"]',
      ),
    );
    expect(steps.map((step) => step.textContent)).toEqual([
      expect.stringContaining('Checkout'),
      expect.stringContaining('Test'),
      expect.stringContaining('Publish package'),
    ]);
    act(() => root.unmount());
  });

  it('hides optional controls when callbacks or YAML are absent', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() =>
      root.render(
        <PipelineReadDetail
          definition={{ ...definition, canonicalYaml: undefined }}
        />,
      ),
    );
    expect(
      container.querySelector(
        '[data-testid="pipeline-read-detail-open-editor"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="pipeline-read-detail-yaml-toggle"]',
      ),
    ).toBeNull();
    act(() => root.unmount());
  });

  it('invokes the optional editor callback and toggles YAML', () => {
    const onOpenEditor = jest.fn();
    const { container, root } = mount(onOpenEditor);
    const open = container.querySelector<HTMLButtonElement>(
      '[data-testid="pipeline-read-detail-open-editor"]',
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="pipeline-read-detail-yaml-toggle"]',
    );
    act(() => open?.click());
    expect(onOpenEditor).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="pipeline-read-detail-yaml"]'),
    ).toBeNull();
    act(() => toggle?.click());
    expect(
      container.querySelector('[data-testid="pipeline-read-detail-yaml"]')
        ?.textContent,
    ).toContain('Release train');
    act(() => toggle?.click());
    expect(
      container.querySelector('[data-testid="pipeline-read-detail-yaml"]'),
    ).toBeNull();
    act(() => root.unmount());
  });

  it('blocks raw YAML and script lines from session replay', () => {
    const { container, root } = mount();
    const blocked = (text: string): boolean => {
      const leaf = Array.from(container.querySelectorAll('p, span, code')).find(
        (element) => element.textContent === text,
      );
      if (!leaf) throw new Error(`${text} not rendered`);
      return leaf.closest(`.${REPLAY_BLOCK_CLASS}`) !== null;
    };
    expect(blocked('npm test')).toBe(true);
    expect(blocked('npm publish')).toBe(true);
    expect(blocked('actions/checkout')).toBe(false);
    expect(blocked('Test')).toBe(false);
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="pipeline-read-detail-yaml-toggle"]',
        )
        ?.click(),
    );
    expect(
      container
        .querySelector('[data-testid="pipeline-read-detail-yaml"]')
        ?.classList.contains(REPLAY_BLOCK_CLASS),
    ).toBe(true);
    act(() => root.unmount());
  });

  it('shows a transfer note when canonical YAML was truncated', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() =>
      root.render(
        <PipelineReadDetail
          definition={{ ...definition, canonicalYamlTruncated: true }}
        />,
      ),
    );

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="pipeline-read-detail-yaml-toggle"]',
    );
    act(() => toggle?.click());
    expect(container.textContent).toContain('YAML truncated in transfer.');
    act(() => root.unmount());
  });
});
