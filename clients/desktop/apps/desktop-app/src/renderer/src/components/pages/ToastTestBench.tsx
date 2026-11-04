import type { JSX } from 'react';
import { Heading, NoticeButton } from '@canopy/ui-shared/components';
import { useGitHubStore } from '@/stores/githubStore';
import { TOAST_TEST_SAMPLES, type ToastSample } from './toastTestSamples';

/**
 * Development-only bench on the Notice states page: each button raises a real
 * toast through the store the app uses, so the shipping `ToastContainer`
 * renders it in place. Every sample is forced in-app and never raises a
 * native banner, so it shows whatever the notification settings are.
 */

function raiseToast(sample: ToastSample): void {
  useGitHubStore.getState().addToast(sample.message, sample.type, undefined, {
    ...sample.meta,
    forceInApp: true,
    suppressOsNotification: true,
  });
}

export function ToastTestBench(): JSX.Element {
  return (
    <section className="mb-12" data-testid="toast-test-bench">
      <Heading level={2} variant="title" className="mb-1">
        Toasts
      </Heading>
      <p className="mb-3 max-w-3xl text-xs fg-secondary">
        Each button shows a real toast. Press several to see them stack. They
        also land in notification history.
      </p>
      <div className="flex max-w-3xl flex-wrap gap-2">
        {TOAST_TEST_SAMPLES.map((sample) => (
          <NoticeButton
            key={sample.id}
            data-testid={`toast-test-${sample.id}`}
            onClick={(): void => raiseToast(sample)}
          >
            {sample.label}
          </NoticeButton>
        ))}
        <NoticeButton
          variant="primary"
          data-testid="toast-test-all"
          onClick={(): void => TOAST_TEST_SAMPLES.forEach(raiseToast)}
        >
          Show all
        </NoticeButton>
      </div>
    </section>
  );
}
