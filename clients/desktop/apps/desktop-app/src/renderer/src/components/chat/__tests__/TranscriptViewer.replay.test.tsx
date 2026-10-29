/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { TranscriptViewer } from '../TranscriptViewer';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('TranscriptViewer session replay', () => {
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

  function renderViewer(className?: string): Element {
    act(() =>
      root.render(
        <TranscriptViewer
          transcriptKey="run-1"
          lines={[]}
          emptyMessage="No transcript yet"
          className={className}
          dataTestId="transcript"
        />,
      ),
    );
    const viewer = container.querySelector('[data-testid="transcript"]');
    if (!viewer) throw new Error('Transcript viewer did not render');
    return viewer;
  }

  it('blocks the transcript root and keeps the caller classes', () => {
    const viewer = renderViewer('max-h-90 overflow-auto');
    expect(viewer.className).toBe(
      `${POSTHOG_REPLAY_BLOCK_CLASS} max-h-90 overflow-auto`,
    );
  });

  it('blocks the transcript root without caller classes', () => {
    const viewer = renderViewer();
    expect(viewer.className).toBe(POSTHOG_REPLAY_BLOCK_CLASS);
    expect(viewer.textContent).toBe('No transcript yet');
  });
});
