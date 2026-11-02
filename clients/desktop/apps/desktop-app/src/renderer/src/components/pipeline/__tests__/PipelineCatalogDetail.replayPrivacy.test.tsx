/**
 * @jest-environment jsdom
 */
jest.mock('@/hooks/useInstalledMarketplaces', () => ({
  useInstalledMarketplaces: (): { marketplaces: []; loading: boolean } => ({
    marketplaces: [],
    loading: false,
  }),
}));
jest.mock('@/hooks/useActiveWorktreeCwd', () => ({
  useActiveWorktreeCwd: (): undefined => undefined,
}));

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { PipelineCatalogDetail } from '../PipelineCatalogDetail';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PIPELINE: PipelineInfo = {
  id: 'shared-1',
  name: 'Deploy acme-payments',
  filename: 'deploy.yaml',
  description: 'Ships the payments service to production.',
  icon: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  source: 'shared',
  readonly: true,
  shareScope: 'organization',
  owner: {
    type: 'organization',
    id: 'org-1',
    name: 'Acme Corp',
  },
};

describe('PipelineCatalogDetail session replay privacy', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(window, {
      pipelines: {
        listCapabilityRefs: jest.fn(() => Promise.resolve({ success: false })),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('shows the name and records the description', async () => {
    await act(async () => {
      root.render(
        <PipelineCatalogDetail pipeline={PIPELINE} onOpenEditor={jest.fn()} />,
      );
      await Promise.resolve();
    });

    const heading = container.querySelector('h2');
    expect(heading?.textContent).toBe('Deploy acme-payments');

    const description = Array.from(container.querySelectorAll('p')).find(
      (paragraph) =>
        paragraph.textContent === 'Ships the payments service to production.',
    );
    expect(description).toBeDefined();
    expect(description?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});
