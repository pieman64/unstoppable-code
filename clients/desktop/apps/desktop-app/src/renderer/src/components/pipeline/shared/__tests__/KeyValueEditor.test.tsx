/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { KeyValueEditor } from '../KeyValueEditor';
import { outermostReplayBlock } from '@/test-utils/replay';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('KeyValueEditor session replay', () => {
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

  it.each([false, true])(
    'records every key, value, and the new-key field; the recorder masks their values (readonly: %s)',
    (readonly) => {
      act(() =>
        root.render(
          <KeyValueEditor
            value={{ API_TOKEN: 'secret', RETRIES: 3 }}
            onChange={(): void => undefined}
            readonly={readonly}
          />,
        ),
      );
      const editor = container.firstElementChild;
      expect(editor?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
        false,
      );
      const fields = Array.from(container.querySelectorAll('input, textarea'));
      expect(fields.length).toBeGreaterThan(0);
      for (const field of fields) {
        expect(outermostReplayBlock(field)).toBeNull();
      }
    },
  );
});
