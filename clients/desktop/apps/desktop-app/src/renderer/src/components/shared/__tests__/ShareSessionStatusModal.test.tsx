/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ShareSessionStatusModal } from '@/components/shared/ShareSessionStatusModal';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useShareSessionStatusStore } from '@/stores/shareSessionStatusStore';

jest.mock('@/lib/shareSessionAction', () => ({
  shareSessionAction: jest.fn().mockResolvedValue(undefined),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('ShareSessionStatusModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useCurrentUiStateStore.setState({ slices: {} });
    useShareSessionStatusStore.setState({
      target: {
        projectId: 'cowork-project',
        worktreeId: 'work-entry',
        chatId: 'chat-1',
      },
      ownerDocument: document,
      status: {
        phase: 'success',
        response: {
          exportId: 'export-1',
          title: 'Portable Cowork session',
          sizeBytes: 2048,
          warnings: [],
        },
      },
      operationId: 1,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
  });

  it('points to compatible-workspace import and explains that export is private', () => {
    act(() => root.render(<ShareSessionStatusModal />));
    const modal = document.querySelector(
      '[data-testid="share-session-status-modal"]',
    );
    expect(modal?.textContent).toContain('Session snapshot exported');
    expect(modal?.textContent).toContain('Import session…');
    expect(modal?.textContent).toContain('compatible project');
    expect(modal?.textContent).toContain(
      'This private export does not create a public link.',
    );
    expect(modal?.textContent).toContain('Portable Cowork session · 2.0 KB');
    expect(
      useCurrentUiStateStore.getState().slices['chat.shareSessionStatusModal'],
    ).toEqual({ open: true, phase: 'success' });
  });

  it('portals into the document where sharing was initiated', () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const ownerDocument = iframe.contentDocument;
    if (ownerDocument === null) {
      throw new Error('Expected iframe owner document');
    }
    useShareSessionStatusStore.setState({ ownerDocument });

    act(() => root.render(<ShareSessionStatusModal />));

    expect(
      ownerDocument.querySelector('[data-testid="share-session-status-modal"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="share-session-status-modal"]'),
    ).toBeNull();
  });
});
