/**
 * @jest-environment jsdom
 */
import { act, type JSX, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCloseOnOutsideMouseDown } from '../useCloseOnOutsideMouseDown';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function HookHarness({
  triggerRef,
  contentRef,
  onClose,
}: {
  triggerRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}): JSX.Element | null {
  useCloseOnOutsideMouseDown(true, triggerRef, contentRef, onClose);
  return null;
}

describe('useCloseOnOutsideMouseDown', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  it('accepts event targets from the trigger document realm', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const auxDocument = iframe.contentDocument;
    expect(auxDocument).not.toBeNull();

    const trigger = (auxDocument as Document).createElement('button');
    const content = (auxDocument as Document).createElement('div');
    const outside = (auxDocument as Document).createElement('div');
    (auxDocument as Document).body.append(trigger, content, outside);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onClose = jest.fn();

    act(() => {
      root.render(
        <HookHarness
          triggerRef={{ current: trigger }}
          contentRef={{ current: content }}
          onClose={onClose}
        />,
      );
    });

    act(() => {
      const mouseDown = (auxDocument as Document).createEvent('MouseEvent');
      mouseDown.initMouseEvent(
        'mousedown',
        true,
        true,
        iframe.contentWindow,
        0,
        0,
        0,
        0,
        0,
        false,
        false,
        false,
        false,
        0,
        null,
      );
      outside.dispatchEvent(mouseDown);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('swallows the click that follows an outside-dismiss mousedown', () => {
    const onClose = jest.fn();
    const outsideClick = jest.fn();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.addEventListener('click', outsideClick);

    const trigger = document.createElement('button');
    const content = document.createElement('div');
    document.body.append(trigger, content);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <HookHarness
          triggerRef={{ current: trigger }}
          contentRef={{ current: content }}
          onClose={onClose}
        />,
      );
    });

    act(() => {
      outside.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // The click completing that dismissal press must not reach the target.
    act(() => {
      outside.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(outsideClick).not.toHaveBeenCalled();

    // The NEXT click behaves normally again.
    act(() => {
      outside.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(outsideClick).toHaveBeenCalledTimes(1);
    outside.remove();
  });
});
