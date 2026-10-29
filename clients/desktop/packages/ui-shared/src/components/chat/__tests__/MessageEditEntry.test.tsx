/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  MessageEditBadge,
  useDoubleClickToEdit,
  type MessageEditHandler,
} from '../MessageEditEntry';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let container: HTMLDivElement;
let root: Root;
const badgeEdit = jest.fn();

beforeEach(() => {
  badgeEdit.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.getSelection()?.removeAllRanges();
});

function Bubble({
  onEdit,
}: {
  onEdit: MessageEditHandler | undefined;
}): JSX.Element {
  const doubleClickToEdit = useDoubleClickToEdit(onEdit);
  return (
    <div data-testid="gutter">
      <div data-testid="surface" {...doubleClickToEdit}>
        <p data-testid="text">
          Queued <strong data-testid="nested">text</strong>
        </p>
        <MessageEditBadge
          testId="badge"
          label="Edit queued message"
          onEdit={badgeEdit}
        />
        <a href="#link" data-testid="link">
          <span data-testid="link-icon">icon</span>
        </a>
        <div data-no-double-click-edit data-testid="attachment">
          file.png
        </div>
      </div>
    </div>
  );
}

function render(onEdit: MessageEditHandler | undefined): HTMLElement {
  act(() => {
    root.render(<Bubble onEdit={onEdit} />);
  });
  return byTestId('text');
}

function byTestId(id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`missing ${id}`);
  return element;
}

function pointerDown(target: Element, pointerType: string): void {
  const event = new MouseEvent('pointerdown', { bubbles: true, button: 0 });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  act(() => {
    target.dispatchEvent(event);
  });
}

interface PressOptions {
  readonly button?: number;
  readonly shiftKey?: boolean;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
}

/** Dispatches the second press; returns whether its default was prevented. */
function doubleClick(
  target: Element,
  pointerType = 'mouse',
  options: PressOptions = {},
): boolean {
  const init = { bubbles: true, cancelable: true, button: 0, ...options };
  pointerDown(target, pointerType);
  act(() => {
    target.dispatchEvent(new MouseEvent('mousedown', { ...init, detail: 1 }));
    target.dispatchEvent(new MouseEvent('mouseup', { ...init, detail: 1 }));
    target.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
  });
  pointerDown(target, pointerType);
  const second = new MouseEvent('mousedown', { ...init, detail: 2 });
  act(() => {
    target.dispatchEvent(second);
    target.dispatchEvent(new MouseEvent('mouseup', { ...init, detail: 2 }));
    target.dispatchEvent(new MouseEvent('click', { ...init, detail: 2 }));
    target.dispatchEvent(new MouseEvent('dblclick', { ...init, detail: 2 }));
  });
  return second.defaultPrevented;
}

function selectContents(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe('useDoubleClickToEdit', () => {
  it('opens the editor once on a primary mouse double-click and suppresses word selection', () => {
    const onEdit = jest.fn();
    const text = render(onEdit);

    expect(byTestId('surface').dataset.doubleClickEdit).toBe('true');
    expect(doubleClick(text)).toBe(true);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('treats pen input like mouse input', () => {
    const onEdit = jest.fn();
    expect(doubleClick(render(onEdit), 'pen')).toBe(true);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('installs no gesture and keeps native selection when editing is unavailable', () => {
    const text = render(undefined);

    expect(byTestId('surface').dataset.doubleClickEdit).toBeUndefined();
    expect(doubleClick(text)).toBe(false);
  });

  it('never edits from a touch double-tap, but a later mouse gesture still works', () => {
    const onEdit = jest.fn();
    const text = render(onEdit);

    expect(doubleClick(text, 'touch')).toBe(false);
    expect(onEdit).not.toHaveBeenCalled();

    expect(doubleClick(text, 'mouse')).toBe(true);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['secondary button', { button: 2 }],
    ['shift', { shiftKey: true }],
    ['meta', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['alt', { altKey: true }],
  ])('ignores a %s double-click', (_label, options) => {
    const onEdit = jest.fn();
    expect(doubleClick(render(onEdit), 'mouse', options)).toBe(false);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it.each(['link', 'link-icon', 'attachment'])(
    'leaves a double-click on %s to that control',
    (id) => {
      const onEdit = jest.fn();
      render(onEdit);

      expect(doubleClick(byTestId(id))).toBe(false);
      expect(onEdit).not.toHaveBeenCalled();
    },
  );

  it('does not add a bubble edit when the Edit badge is double-clicked', () => {
    const onEdit = jest.fn();
    render(onEdit);

    expect(doubleClick(byTestId('badge'))).toBe(false);
    expect(onEdit).not.toHaveBeenCalled();
    // The badge's own clicks are the only edit requests.
    expect(badgeEdit).toHaveBeenCalledTimes(1);
  });

  it('edits from nested non-interactive content', () => {
    const onEdit = jest.fn();
    render(onEdit);

    doubleClick(byTestId('nested'));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('ignores a double-click in the gutter around the bubble', () => {
    const onEdit = jest.fn();
    render(onEdit);

    doubleClick(byTestId('gutter'));
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('keeps a selection that touched the bubble before the gesture began', () => {
    const onEdit = jest.fn();
    const text = render(onEdit);
    selectContents(text);

    expect(doubleClick(text)).toBe(false);
    expect(onEdit).not.toHaveBeenCalled();
    expect(document.getSelection()?.isCollapsed).toBe(false);
  });

  it('does not clear or honor an unrelated selection elsewhere in the page', () => {
    const elsewhere = document.createElement('p');
    elsewhere.textContent = 'Unrelated text';
    document.body.append(elsewhere);
    const onEdit = jest.fn();
    const text = render(onEdit);
    selectContents(elsewhere);

    doubleClick(text);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(document.getSelection()?.toString()).toBe('Unrelated text');
    elsewhere.remove();
  });

  it('resets the gesture after a pointer cancellation', () => {
    const onEdit = jest.fn();
    const text = render(onEdit);
    act(() => {
      text.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1 }),
      );
      text.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }));
      text.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, button: 0, detail: 2 }),
      );
    });

    expect(onEdit).not.toHaveBeenCalled();
  });

  it('ignores repeat gestures while an asynchronous edit request is pending', async () => {
    let resolve: () => void = () => undefined;
    const onEdit = jest.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const text = render(onEdit);

    doubleClick(text);
    expect(doubleClick(text)).toBe(false);
    expect(onEdit).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve();
      await Promise.resolve();
    });
    doubleClick(text);
    expect(onEdit).toHaveBeenCalledTimes(2);
  });

  it('survives a host re-render between presses and calls the latest handler', () => {
    const first = jest.fn();
    const second = jest.fn();
    const text = render(first);
    const init = { bubbles: true, cancelable: true, button: 0 };
    act(() => {
      text.dispatchEvent(new MouseEvent('mousedown', { ...init, detail: 1 }));
    });
    render(second);
    act(() => {
      text.dispatchEvent(new MouseEvent('mousedown', { ...init, detail: 2 }));
      text.dispatchEvent(new MouseEvent('dblclick', { ...init, detail: 2 }));
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('resets a pending gesture when eligibility changes mid-gesture', () => {
    const onEdit = jest.fn();
    const text = render(onEdit);
    const init = { bubbles: true, cancelable: true, button: 0 };
    act(() => {
      text.dispatchEvent(new MouseEvent('mousedown', { ...init, detail: 1 }));
    });
    render(undefined);
    render(onEdit);
    act(() => {
      text.dispatchEvent(new MouseEvent('dblclick', { ...init, detail: 2 }));
    });

    expect(onEdit).not.toHaveBeenCalled();
  });

  it('stops editing once eligibility is withdrawn', () => {
    const onEdit = jest.fn();
    const text = render(onEdit);
    render(undefined);

    expect(doubleClick(text)).toBe(false);
    expect(onEdit).not.toHaveBeenCalled();
  });
});
