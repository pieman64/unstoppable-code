/** @jest-environment jsdom */

import { DragAndDropObserver } from '../dnd-observer';
import type { IDragAndDropObserverCallbacks } from '../dnd-observer';

function fire(target: Element, type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('DragAndDropObserver', () => {
  let root: HTMLElement;
  let child: HTMLElement;
  let observer: DragAndDropObserver | undefined;

  beforeEach(() => {
    root = document.createElement('div');
    child = document.createElement('div');
    root.appendChild(child);
    document.body.appendChild(root);
    observer = undefined;
  });

  afterEach(() => {
    observer?.dispose();
    root.remove();
  });

  function observe(
    callbacks: IDragAndDropObserverCallbacks,
  ): DragAndDropObserver {
    observer = new DragAndDropObserver(root, callbacks);
    return observer;
  }

  it('does not fire onDragLeave when moving between children, only when leaving the root subtree', () => {
    const onDragEnter = jest.fn();
    const onDragLeave = jest.fn();
    observe({ onDragEnter, onDragLeave });

    fire(root, 'dragenter'); // counter: 1
    fire(child, 'dragenter'); // bubbles to root, counter: 2
    expect(onDragEnter).toHaveBeenCalledTimes(2);

    fire(child, 'dragleave'); // counter: 1 — still inside the subtree
    expect(onDragLeave).not.toHaveBeenCalled();

    fire(root, 'dragleave'); // counter: 0 — truly left
    expect(onDragLeave).toHaveBeenCalledTimes(1);
  });

  it('resets the counter on drop so the next enter/leave cycle fires onDragLeave again', () => {
    const onDragLeave = jest.fn();
    const onDrop = jest.fn();
    observe({ onDragLeave, onDrop });

    fire(root, 'dragenter'); // counter: 1
    fire(child, 'dragenter'); // counter: 2
    fire(child, 'drop'); // counter reset to 0
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDragLeave).not.toHaveBeenCalled();

    fire(root, 'dragenter'); // counter: 1 (fresh cycle)
    fire(root, 'dragleave'); // counter: 0
    expect(onDragLeave).toHaveBeenCalledTimes(1);
  });

  it('resets the counter on dragend', () => {
    const onDragLeave = jest.fn();
    const onDragEnd = jest.fn();
    observe({ onDragLeave, onDragEnd });

    fire(root, 'dragenter');
    fire(child, 'dragenter');
    fire(root, 'dragend');
    expect(onDragEnd).toHaveBeenCalledTimes(1);

    fire(root, 'dragenter');
    fire(root, 'dragleave');
    expect(onDragLeave).toHaveBeenCalledTimes(1);
  });

  it('fires onDragOver with the event and a numeric drag duration, and prevents default', () => {
    const onDragOver = jest.fn();
    observe({ onDragOver });

    fire(root, 'dragenter');
    const event = fire(root, 'dragover');

    expect(onDragOver).toHaveBeenCalledTimes(1);
    expect(onDragOver).toHaveBeenCalledWith(event, expect.any(Number));
    expect(event.defaultPrevented).toBe(true);
  });

  it('fires onDragStart and onDrag when provided', () => {
    const onDragStart = jest.fn();
    const onDrag = jest.fn();
    observe({ onDragStart, onDrag });

    const startEvent = fire(root, 'dragstart');
    const dragEvent = fire(root, 'drag');

    expect(onDragStart).toHaveBeenCalledWith(startEvent);
    expect(onDrag).toHaveBeenCalledWith(dragEvent);
  });

  it('removes all listeners on dispose', () => {
    const onDragEnter = jest.fn();
    const onDragOver = jest.fn();
    const onDrop = jest.fn();
    const disposable = observe({ onDragEnter, onDragOver, onDrop });

    disposable.dispose();

    fire(root, 'dragenter');
    const overEvent = fire(root, 'dragover');
    fire(root, 'drop');

    expect(onDragEnter).not.toHaveBeenCalled();
    expect(onDragOver).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
    expect(overEvent.defaultPrevented).toBe(false);
  });
});
