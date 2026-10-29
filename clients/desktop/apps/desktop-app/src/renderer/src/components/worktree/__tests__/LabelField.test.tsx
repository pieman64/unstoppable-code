/**
 * @jest-environment jsdom
 *
 * Uses the repo's createRoot + act jsdom convention (see
 * VariableInsertDropdown.test.tsx); @testing-library/react is not installed.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LabelField } from '../LabelField';

function fireClick(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  );
  const setter = descriptor?.set?.bind(input);
  setter?.(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

let root: Root | null = null;

function render(node: ReactNode): void {
  root = createRoot(document.body);
  act(() => {
    root?.render(node);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = '';
});

function display(): HTMLElement | null {
  return document.body.querySelector('[data-testid="label-field-display"]');
}

function input(): HTMLInputElement | null {
  return document.body.querySelector('[data-testid="label-field-input"]');
}

describe('LabelField', () => {
  it('shows the generated fallback in non-edit mode when no label is set', () => {
    render(
      <LabelField label={undefined} fallback="dev-swan" onSubmit={jest.fn()} />,
    );
    expect(display()?.textContent).toBe('dev-swan');
    // Muted styling signals the fallback rather than a custom label.
    expect(display()?.className).toContain('fg-secondary');
  });

  it('shows the custom label (not the fallback) when one is set', () => {
    render(
      <LabelField label="My Label" fallback="dev-swan" onSubmit={jest.fn()} />,
    );
    expect(display()?.textContent).toBe('My Label');
    expect(display()?.className).toContain('fg-primary');
  });

  it('opens the edit input empty when only a fallback is in use', () => {
    render(
      <LabelField
        label={undefined}
        fallback="dev-swan"
        startInEdit
        onSubmit={jest.fn()}
        onEditConsumed={jest.fn()}
      />,
    );
    expect(input()).not.toBeNull();
    expect(input()?.value).toBe('');
    // The fallback is offered as a placeholder.
    expect(input()?.placeholder).toBe('dev-swan');
  });

  it('pre-fills the edit input with the existing custom label', () => {
    render(
      <LabelField
        label="My Label"
        fallback="dev-swan"
        startInEdit
        onSubmit={jest.fn()}
        onEditConsumed={jest.fn()}
      />,
    );
    expect(input()?.value).toBe('My Label');
  });

  it('submits a trimmed label on save', async () => {
    const onSubmit = jest.fn();
    render(
      <LabelField
        label={undefined}
        fallback="dev-swan"
        startInEdit
        onSubmit={onSubmit}
        onEditConsumed={jest.fn()}
      />,
    );
    const field = input();
    expect(field).not.toBeNull();
    act(() => {
      if (field) setInputValue(field, '  Renamed  ');
    });
    const save = document.body.querySelector(
      '[data-testid="label-field-save"]',
    );
    await act(async () => {
      if (save) fireClick(save);
      await Promise.resolve();
    });
    expect(onSubmit).toHaveBeenCalledWith('Renamed');
  });

  it('clears the label (empty submit) so the fallback is restored', async () => {
    const onSubmit = jest.fn();
    render(
      <LabelField
        label="My Label"
        fallback="dev-swan"
        startInEdit
        onSubmit={onSubmit}
        onEditConsumed={jest.fn()}
      />,
    );
    const field = input();
    act(() => {
      if (field) setInputValue(field, '   ');
    });
    const save = document.body.querySelector(
      '[data-testid="label-field-save"]',
    );
    await act(async () => {
      if (save) fireClick(save);
      await Promise.resolve();
    });
    expect(onSubmit).toHaveBeenCalledWith('');
  });

  it('keeps edit mode active when saving fails', async () => {
    const onSubmit = jest.fn().mockRejectedValue(new Error('nope'));
    render(
      <LabelField
        label={undefined}
        fallback="dev-swan"
        startInEdit
        onSubmit={onSubmit}
        onEditConsumed={jest.fn()}
      />,
    );
    const field = input();
    expect(field).not.toBeNull();
    act(() => {
      if (field) setInputValue(field, 'Renamed');
    });
    const save = document.body.querySelector(
      '[data-testid="label-field-save"]',
    );
    await act(async () => {
      if (save) fireClick(save);
      await Promise.resolve();
    });

    expect(onSubmit).toHaveBeenCalledWith('Renamed');
    expect(input()).not.toBeNull();
    expect(input()?.disabled).toBe(false);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not save label. Try again.',
    );
  });
});
