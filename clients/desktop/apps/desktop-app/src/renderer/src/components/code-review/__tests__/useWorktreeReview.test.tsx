/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import {
  emptyCodeReviewFile,
  type CodeReviewUpdatedEvent,
  type CodeReviewGetResponse,
  type CodeReviewModalOpenRequest,
} from '@canopy/desktop-shared/types';
import { useWorktreeReview } from '../useWorktreeReview';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
function Panel({ visible = true }: { visible?: boolean }): JSX.Element {
  const state = useWorktreeReview('p', 'w', true, visible);
  return <span>{state.fingerprint ?? 'loading'}</span>;
}
it('shares artifact reads, ignores late initial data, and releases per-panel visibility and the final subscription', async () => {
  let receive: (event: CodeReviewUpdatedEvent) => void = () => undefined;
  let resolveGet: (response: CodeReviewGetResponse) => void = () => undefined;
  const release = jest.fn();
  const onUpdated = jest.fn((callback: typeof receive): (() => void) => {
    receive = callback;
    return release;
  });
  const get = jest.fn(
    () =>
      new Promise<CodeReviewGetResponse>((resolve) => {
        resolveGet = resolve;
      }),
  );
  const setModalOpen = jest.fn(
    (_request: CodeReviewModalOpenRequest): Promise<void> => {
      void _request;
      return Promise.resolve();
    },
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { codeReview: { get, onUpdated, setModalOpen } },
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => {
      await Promise.resolve();
      root.render(
        <>
          <Panel key="a" />
          <Panel key="b" />
        </>,
      );
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(setModalOpen).toHaveBeenCalledTimes(2);
    await act(async () => {
      await Promise.resolve();
      receive({
        projectId: 'p',
        worktreeId: 'w',
        fingerprint: 'fresh',
        review: emptyCodeReviewFile(),
      });
      resolveGet({ fingerprint: 'stale', review: emptyCodeReviewFile() });
    });
    expect(container.textContent).toBe('freshfresh');
    await act(async () => {
      await Promise.resolve();
      root.render(<Panel key="a" visible={false} />);
    });
    expect(release).not.toHaveBeenCalled();
    expect(
      setModalOpen.mock.calls.filter(([request]) => request.open === false),
    ).toHaveLength(2);
  } finally {
    await act(async () => {
      await Promise.resolve();
      root.unmount();
    });
  }
  expect(release).toHaveBeenCalledTimes(1);
});
