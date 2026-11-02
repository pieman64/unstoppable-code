/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RenameDialog, type RenameDialogProps } from '../RenameDialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];

function render(node: JSX.Element): Root {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(node));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
});

function dialog(
  overrides: Partial<RenameDialogProps> = {},
): RenameDialogProps & { onSubmit: jest.Mock; onClose: jest.Mock } {
  return {
    title: 'Rename chat',
    label: 'Name',
    initialValue: 'Current',
    inputTestId: 'rename-input',
    submitTestId: 'rename-save',
    cancelTestId: 'rename-cancel',
    ...overrides,
    onSubmit: jest.fn(),
    onClose: jest.fn(),
  };
}

function input(): HTMLInputElement {
  const element = document.querySelector('[data-testid="rename-input"]');
  if (!(element instanceof HTMLInputElement)) throw new Error('no input');
  return element;
}

function button(testId: string): HTMLButtonElement {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLButtonElement)) throw new Error('no button');
  return element;
}

function typeValue(value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  );
  act(() => {
    descriptor?.set?.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('RenameDialog', () => {
  it('takes the compact confirmation shape with a capsule field and Enter to submit', () => {
    const props = dialog();
    render(<RenameDialog {...props} />);
    const card = document.querySelector('[role="dialog"]');
    expect(card?.className).toContain('max-w-95');
    // No header rule and no close button: Cancel and Escape close it.
    expect(card?.querySelector('[aria-label="Close"]')).toBeNull();
    expect(card?.querySelector('.border-b')).toBeNull();
    // The field rests on the neutral edge and focuses to the neutral halo.
    expect(input().className).toContain('rounded-full');
    expect(input().className).toContain('focus-visible:shadow-field-focus');
    expect(input().className).not.toContain('focus-ring');
    expect(button('rename-cancel').className).toContain('rounded-full');
    // Escape on Cancel and Enter on Rename sit inside the buttons.
    for (const id of ['rename-cancel', 'rename-save']) {
      expect(
        button(id).querySelector('[data-testid="kbd-chip"]'),
      ).toBeInstanceOf(Element);
    }
    typeValue('   ');
    act(() => {
      input().form?.requestSubmit();
    });
    expect(props.onSubmit).toHaveBeenCalledWith('   ');
  });

  it('focuses and selects the initial value with host copy and limits', () => {
    render(
      <RenameDialog
        {...dialog({
          placeholder: 'Generated name',
          helperText: 'Leave empty to use the generated name.',
          maxLength: 12,
        })}
      />,
    );
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe('Current'.length);
    expect(input().placeholder).toBe('Generated name');
    expect(input().maxLength).toBe(12);
    expect(document.body.textContent).toContain(
      'Leave empty to use the generated name.',
    );
    expect(button('rename-save').getAttribute('aria-label')).toBeNull();
    expect(button('rename-save').firstChild?.textContent).toBe('Rename');
    expect(button('rename-save').className).toContain('bg-accent');
  });

  it('submits the raw draft and leaves normalization to the host', () => {
    const props = dialog();
    render(<RenameDialog {...props} />);
    typeValue('  Next  ');
    act(() => button('rename-save').click());
    expect(props.onSubmit).toHaveBeenCalledWith('  Next  ');
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('does not submit while an IME composition commits on Enter', () => {
    const props = dialog();
    render(<RenameDialog {...props} />);
    const composing = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    act(() => {
      input().dispatchEvent(composing);
    });
    expect(composing.defaultPrevented).toBe(true);
  });

  it('closes from Cancel, Escape and the backdrop without submitting', () => {
    const props = dialog();
    render(<RenameDialog {...props} />);
    act(() => button('rename-cancel').click());
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    const backdrop = document.querySelector(
      '[data-canopy-overlay-root="modal"]',
    );
    act(() => {
      backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(props.onClose).toHaveBeenCalledTimes(3);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('blocks dismissal and resubmission while busy', () => {
    const props = dialog({ busy: true });
    render(<RenameDialog {...props} />);
    expect(button('rename-save').disabled).toBe(true);
    // A busy submit does not offer Enter.
    expect(
      button('rename-save').querySelector('[data-testid="kbd-chip"]'),
    ).toBeNull();
    act(() => {
      input().form?.requestSubmit();
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('reopens with a fresh initial value', () => {
    const props = dialog();
    const root = render(<RenameDialog key="a" {...props} />);
    typeValue('Edited');
    act(() =>
      root.render(<RenameDialog key="b" {...props} initialValue="Fresh" />),
    );
    expect(input().value).toBe('Fresh');
  });

  describe('field error', () => {
    const DUPLICATE = 'A workflow named “Bug fix” already exists.';

    function error(): HTMLElement | null {
      return document.querySelector<HTMLElement>(
        '[data-testid="rename-input-error"]',
      );
    }

    it('shows nothing before the person submits, even for a value the host rejects', () => {
      const props = dialog({ error: DUPLICATE });
      render(<RenameDialog {...props} />);
      typeValue('Bug fix');
      expect(error()).toBeNull();
      expect(input().getAttribute('aria-invalid')).toBeNull();
    });

    it('shows the error under the field after submit, linked to it, and keeps the text', () => {
      const props = dialog({ helperText: 'Names are shared.' });
      const root = render(<RenameDialog {...props} />);
      typeValue('Bug fix');
      act(() => button('rename-save').click());
      expect(props.onSubmit).toHaveBeenCalledWith('Bug fix');
      act(() => root.render(<RenameDialog {...props} error={DUPLICATE} />));

      const message = error();
      expect(message).toBeInstanceOf(HTMLElement);
      expect(message?.textContent).toBe(DUPLICATE);
      expect(input().value).toBe('Bug fix');
      expect(input().getAttribute('aria-invalid')).toBe('true');
      const describedBy = input().getAttribute('aria-describedby') ?? '';
      expect(describedBy.split(' ')).toContain(message?.id);
      expect(describedBy.split(' ')).toHaveLength(2);
      // Under the field, before the helper and the buttons.
      expect(
        input().compareDocumentPosition(message ?? document.body) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('clears the error as soon as the field is edited, and shows it again on the next submit', () => {
      const props = dialog();
      const root = render(<RenameDialog {...props} />);
      typeValue('Bug fix');
      act(() => button('rename-save').click());
      act(() => root.render(<RenameDialog {...props} error={DUPLICATE} />));
      expect(error()).toBeInstanceOf(HTMLElement);

      typeValue('Bug fix for Windows');
      expect(error()).toBeNull();
      expect(input().getAttribute('aria-invalid')).toBeNull();
      expect(input().value).toBe('Bug fix for Windows');

      typeValue('Bug fix');
      expect(error()).toBeNull();
      act(() => button('rename-save').click());
      expect(error()?.textContent).toBe(DUPLICATE);
    });
  });
});
