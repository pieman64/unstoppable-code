/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  VoiceRecordingRow,
  formatRecordingDuration,
} from '../VoiceRecordingRow';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('formatRecordingDuration', () => {
  it('reads as minutes and zero-padded seconds', () => {
    expect(formatRecordingDuration(0)).toBe('0:00');
    expect(formatRecordingDuration(6_400)).toBe('0:06');
    expect(formatRecordingDuration(75_000)).toBe('1:15');
  });
});

describe('VoiceRecordingRow', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-30T10:00:00Z'));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  function render(
    overrides: Partial<Parameters<typeof VoiceRecordingRow>[0]>,
  ): {
    onCancel: jest.Mock;
    onStop: jest.Mock;
    onSend: jest.Mock;
  } {
    const handlers = {
      onCancel: jest.fn(),
      onStop: jest.fn(),
      onSend: jest.fn(),
    };
    act(() => {
      root.render(
        <VoiceRecordingRow
          readLevel={(): number => 0}
          listeningSince={Date.now()}
          {...handlers}
          {...overrides}
        />,
      );
    });
    return handlers;
  }

  function byTestId(id: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      `[data-testid="${id}"]`,
    );
    if (!element) throw new Error(`missing ${id}`);
    return element;
  }

  it('counts the take up from when listening began', () => {
    render({});
    expect(byTestId('voice-recording-duration').textContent).toBe('0:00');
    act(() => {
      jest.advanceTimersByTime(6_200);
    });
    expect(byTestId('voice-recording-duration').textContent).toBe('0:06');
  });

  it('cancels, stops and sends through its three buttons', () => {
    const handlers = render({});
    act(() => byTestId('voice-recording-cancel').click());
    act(() => byTestId('voice-recording-stop').click());
    act(() => byTestId('voice-recording-send').click());
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onStop).toHaveBeenCalledTimes(1);
    expect(handlers.onSend).toHaveBeenCalledTimes(1);
  });

  it('names every icon-only control by its action', () => {
    render({});
    expect(byTestId('voice-recording-cancel').getAttribute('aria-label')).toBe(
      'Discard recording',
    );
    expect(byTestId('voice-recording-stop').getAttribute('aria-label')).toBe(
      'Stop recording',
    );
    expect(byTestId('voice-recording-send').getAttribute('aria-label')).toBe(
      'Send message',
    );
  });
});
