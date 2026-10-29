/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastTestBench } from '../ToastTestBench';
import { TOAST_TEST_SAMPLES } from '../toastTestSamples';
import { useGitHubStore } from '@/stores/githubStore';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

describe('ToastTestBench', () => {
  it('raises each sample through the app toast store, forced in-app', () => {
    const addToast = jest.fn();
    const original = useGitHubStore.getState().addToast;
    useGitHubStore.setState({ addToast });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => root.render(<ToastTestBench />));
      for (const sample of TOAST_TEST_SAMPLES) {
        act(() =>
          container
            .querySelector<HTMLButtonElement>(
              `[data-testid="toast-test-${sample.id}"]`,
            )
            ?.click(),
        );
        expect(addToast).toHaveBeenLastCalledWith(
          sample.message,
          sample.type,
          undefined,
          expect.objectContaining({
            forceInApp: true,
            suppressOsNotification: true,
          }),
        );
      }
      expect(addToast).toHaveBeenCalledTimes(TOAST_TEST_SAMPLES.length);

      act(() =>
        container
          .querySelector<HTMLButtonElement>('[data-testid="toast-test-all"]')
          ?.click(),
      );
      expect(addToast).toHaveBeenCalledTimes(TOAST_TEST_SAMPLES.length * 2);
    } finally {
      act(() => root.unmount());
      container.remove();
      useGitHubStore.setState({ addToast: original });
    }
  });
});
