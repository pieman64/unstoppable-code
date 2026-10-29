/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PipelinePublicShareRow } from '../PipelinePublicShareRow';

const resolveSharedPipelineUrl = jest.fn(() =>
  Promise.resolve('https://cloud.example.test/share/pipelines/public-1'),
);
jest.mock('@/lib/share-links', () => ({
  resolveSharedPipelineUrl: (sharePath: string): Promise<string | null> =>
    resolveSharedPipelineUrl(sharePath),
}));

const copyTextToClipboard = jest.fn(() => Promise.resolve(true));
jest.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: (value: string): Promise<boolean> =>
    copyTextToClipboard(value),
}));

const PUBLIC_SHARE = {
  externalId: 'public-1',
  pinnedContentHash: 'sha256:abc',
  upToDate: false,
  sharePath: '/share/pipelines/public-1',
  createdAt: '2026-07-30T00:00:00Z',
  updatedAt: '2026-07-30T00:00:00Z',
};

describe('PipelinePublicShareRow', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.assign(window, {
      pipelines: {
        publishPublicShare: jest.fn(),
        revokePublicShare: jest.fn(),
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders URL and copy only in read-only mode', async () => {
    await act(async () => {
      root.render(
        <PipelinePublicShareRow
          remoteId="remote-1"
          initialShare={PUBLIC_SHARE}
          canManage={false}
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      'https://cloud.example.test/share/pipelines/public-1',
    );
    expect(container.textContent).toContain('Copy link');
    expect(container.textContent).not.toContain('Publish');
    expect(container.textContent).not.toContain('Update to latest');
    expect(container.textContent).not.toContain('Remove');
  });

  it('renders nothing in read-only mode without a share', () => {
    act(() => {
      root.render(
        <PipelinePublicShareRow
          remoteId="remote-1"
          initialShare={null}
          canManage={false}
        />,
      );
    });

    expect(
      container.querySelector('[data-testid="pipeline-public-share-row"]'),
    ).toBeNull();
  });

  it('keeps the publish action in manage mode without a share', () => {
    act(() => {
      root.render(
        <PipelinePublicShareRow remoteId="remote-1" initialShare={null} />,
      );
    });

    expect(container.textContent).toContain('Publish');
  });
});
