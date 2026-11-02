/** @jest-environment jsdom */
import { act, useRef, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { useComposerHintActivity } from '../useComposerHintActivity';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

it.each([true, false])(
  'tracks composition through inactive composers (ended: %s)',
  (ended) => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let composing = false;
    function Probe({ enabled }: { enabled: boolean }): JSX.Element {
      const ref = useRef<HTMLDivElement>(null);
      composing = useComposerHintActivity(ref, enabled).composing;
      return <div ref={ref} />;
    }
    try {
      act(() => root.render(<Probe enabled />));
      act(() => {
        container.firstElementChild?.dispatchEvent(
          new Event('compositionstart', { bubbles: true }),
        );
      });
      expect(composing).toBe(true);
      act(() => root.render(<Probe enabled={false} />));
      // The platform may end composition while this node has no listeners.
      if (ended) {
        act(() => {
          container.firstElementChild?.dispatchEvent(
            new Event('compositionend', { bubbles: true }),
          );
        });
      }
      act(() => root.render(<Probe enabled />));
      expect(composing).toBe(!ended);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  },
);
