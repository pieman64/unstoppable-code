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
  it('keeps the existing inset presentation and submits raw empty input', () => {
    const props = dialog({ variant: 'inset' });
    render(<RenameDialog {...props} />);
    expect(input().className).toContain('inset-ring-line-base');
    expect(input().closest('label')).toBeNull();
    expect(input().form?.className).toBe('');
    expect(button('rename-save').className).not.toContain('bg-accent');
    typeValue('   ');
    act(() => button('rename-save').click());
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
    expect(button('rename-save').textContent).toBe('Save');
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
});
