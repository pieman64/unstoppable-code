/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { hasEscapeEnabledOverlay } from '@canopy/ui-shared/components';
import { ScheduleMessageModal } from '../ScheduleMessageModal';

function dispatchEscape(alreadyHandled = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  if (alreadyHandled) event.preventDefault();
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
}

describe('ScheduleMessageModal', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onCancel = jest.fn();
  const onSave = jest.fn();

  beforeEach(() => {
    onCancel.mockReset();
    onSave.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root.render(<ScheduleMessageModal onCancel={onCancel} onSave={onSave} />);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('closes on Escape', () => {
    const event = dispatchEscape();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores an Escape another overlay already handled', () => {
    dispatchEscape(true);

    expect(onCancel).not.toHaveBeenCalled();
  });

  it('owns Escape as an overlay only while mounted', () => {
    expect(hasEscapeEnabledOverlay(document)).toBe(true);

    act(() => {
      root.unmount();
    });
    root = createRoot(container);

    expect(hasEscapeEnabledOverlay(document)).toBe(false);
  });
});
