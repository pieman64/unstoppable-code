/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  EmailRecipientInput,
  isEmailRecipientValid,
} from '../EmailRecipientInput';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('isEmailRecipientValid', () => {
  it.each([
    ['person@example.com', true],
    ['  person@example.com  ', true],
    ['', false],
    ['person', false],
    ['person@example', false],
    ['two words@example.com', false],
    ['a@b@example.com', false],
    [`${'a'.repeat(245)}@example.com`, false],
    [`${'a'.repeat(320)}@example.com`, false],
  ])('%s -> %s', (value, expected) => {
    expect(isEmailRecipientValid(value)).toBe(expected);
  });
});

describe('EmailRecipientInput', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function input(): HTMLInputElement {
    const element = container.querySelector<HTMLInputElement>(
      '[data-testid="email"]',
    );
    if (!element) throw new Error('input not rendered');
    return element;
  }

  it('labels the field and shows helper text while empty', () => {
    act(() =>
      root.render(
        <EmailRecipientInput
          label="Email"
          value=""
          onChange={() => undefined}
          helperText="They get an email with a link."
          dataTestId="email"
        />,
      ),
    );
    expect(container.querySelector('label')?.textContent).toBe('Email');
    expect(input().getAttribute('aria-invalid')).toBe('false');
    expect(container.textContent).toContain('They get an email with a link.');
    expect(container.querySelector('[data-testid="email-error"]')).toBeNull();
  });

  it('renders a description between the label and the field', () => {
    act(() =>
      root.render(
        <EmailRecipientInput
          label="Email"
          description="We'll email them an invite."
          value=""
          onChange={() => undefined}
          helperText="Helper"
          dataTestId="email"
        />,
      ),
    );
    const label = container.querySelector('label');
    const description = container.querySelector<HTMLParagraphElement>(
      '[data-testid="email-description"]',
    );
    expect(label?.className).toContain('font-medium fg-primary');
    expect(description?.textContent).toBe("We'll email them an invite.");
    expect(label?.nextElementSibling).toBe(description);
    expect(description?.nextElementSibling).toBe(input());
    const describedBy = input().getAttribute('aria-describedby')?.split(' ');
    expect(describedBy).toHaveLength(2);
    expect(describedBy?.[0]).toBe(description?.id);
  });

  it('omits the description when none is given', () => {
    act(() =>
      root.render(
        <EmailRecipientInput
          label="Email"
          value=""
          onChange={() => undefined}
          dataTestId="email"
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="email-description"]'),
    ).toBeNull();
    expect(input().hasAttribute('aria-describedby')).toBe(false);
  });

  function renderField(value: string, onChange = jest.fn()): void {
    act(() =>
      root.render(
        <EmailRecipientInput
          label="Email"
          value={value}
          onChange={onChange}
          helperText="Helper"
          dataTestId="email"
        />,
      ),
    );
  }

  function error(): Element | null {
    return container.querySelector('[data-testid="email-error"]');
  }

  it('holds the error back while an invalid address is being typed', () => {
    renderField('not-an');
    act(() => input().focus());
    expect(input().getAttribute('aria-invalid')).toBe('false');
    expect(error()).toBeNull();
    expect(container.textContent).toContain('Helper');
  });

  it('replaces the helper with an inline error once focus leaves an invalid address', () => {
    renderField('not-an-email');
    act(() => {
      input().focus();
      input().blur();
    });
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(error()?.textContent).toBe('Enter a valid email address.');
    expect(container.textContent).not.toContain('Helper');
  });

  it('clears the revealed error on the next edit', () => {
    const onChange = jest.fn();
    renderField('not-an-email', onChange);
    act(() => {
      input().focus();
      input().blur();
    });
    expect(error()).not.toBeNull();
    act(() => {
      input().focus();
      Reflect.set(
        HTMLInputElement.prototype,
        'value',
        'not-an-email2',
        input(),
      );
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('not-an-email2');
    expect(error()).toBeNull();
  });

  it('never shows the error for a valid or empty address after blur', () => {
    renderField('person@example.com');
    act(() => {
      input().focus();
      input().blur();
    });
    expect(error()).toBeNull();
    renderField('   ');
    expect(error()).toBeNull();
  });

  it('reveals the error when Enter is pressed on an invalid address', () => {
    renderField('nope');
    act(() => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(error()?.textContent).toBe('Enter a valid email address.');
  });

  it('submits on Enter only when the address is valid', () => {
    const onSubmit = jest.fn();
    const render = (value: string): void =>
      act(() =>
        root.render(
          <EmailRecipientInput
            label="Email"
            value={value}
            onChange={() => undefined}
            onSubmit={onSubmit}
            dataTestId="email"
          />,
        ),
      );
    render('nope');
    act(() => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onSubmit).not.toHaveBeenCalled();
    render('person@example.com');
    act(() => {
      input().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
