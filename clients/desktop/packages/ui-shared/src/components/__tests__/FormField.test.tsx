/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DialogFormField } from '../DialogFormField';
import { Select, TextArea, TextInput } from '../Field';
import { FormField } from '../FormField';
import { SettingsSelect } from '../SettingsSelect';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('FormField', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(node: React.ReactNode): void {
    act(() => root.render(node));
  }

  it('names the control with its label and points it at the help text', () => {
    render(
      <FormField label="Name" description="Shown to your team.">
        {(control) => <TextInput {...control} />}
      </FormField>,
    );
    const input = container.querySelector('input');
    const label = container.querySelector('label');
    expect(input?.id).toBeTruthy();
    expect(label?.htmlFor).toBe(input?.id);
    const describedBy = input?.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Shown to your team.',
    );
    expect(input?.hasAttribute('aria-invalid')).toBe(false);
  });

  it('shows the error under the control, before the help text, and marks it invalid', () => {
    render(
      <FormField
        id="memory-title"
        label="Title"
        description="A short name."
        error="Enter a title."
        dataTestId="title-field"
      >
        {(control) => <TextArea {...control} />}
      </FormField>,
    );
    const textarea = container.querySelector('textarea');
    expect(textarea?.id).toBe('memory-title');
    expect(textarea?.getAttribute('aria-invalid')).toBe('true');
    expect(textarea?.getAttribute('aria-describedby')).toBe(
      'memory-title-error memory-title-description',
    );
    const error = container.querySelector('[data-testid="title-field-error"]');
    expect(error?.textContent).toContain('Enter a title.');
    expect(error?.className).toContain('fg-destructive');
    const order = Array.from(
      container.querySelectorAll('[data-testid="title-field"] > *'),
    ).map((element) => element.tagName.toLowerCase());
    expect(order).toEqual(['label', 'div', 'p', 'p']);
  });

  it('leaves the control unmarked with no error and no help text', () => {
    render(
      <FormField label="Name" error={null} description="">
        {(control) => <TextInput {...control} />}
      </FormField>,
    );
    const input = container.querySelector('input');
    expect(input?.hasAttribute('aria-describedby')).toBe(false);
    expect(input?.hasAttribute('aria-invalid')).toBe(false);
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });

  it('labels a Select trigger and reports its error', () => {
    render(
      <FormField label="Environment" error="Choose an environment.">
        {(control) => (
          <Select
            {...control}
            options={[{ value: 'staging', label: 'Staging' }]}
            value={null}
            onValueChange={() => undefined}
          />
        )}
      </FormField>,
    );
    const trigger = container.querySelector('[role="combobox"]');
    const label = container.querySelector('label');
    expect(label?.htmlFor).toBe(trigger?.id);
    expect(trigger?.getAttribute('aria-invalid')).toBe('true');
    const describedBy = trigger?.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toContain(
      'Choose an environment.',
    );
  });

  it('names a Select menu after the field label', () => {
    render(
      <FormField label="Environment">
        {(control) => (
          <Select
            {...control}
            options={[{ value: 'staging', label: 'Staging' }]}
            value={null}
            onValueChange={() => undefined}
          />
        )}
      </FormField>,
    );
    const trigger = container.querySelector<HTMLElement>('[role="combobox"]');
    act(() => trigger?.click());
    const listbox = document.querySelector('[role="listbox"]');
    const labelledBy = listbox?.getAttribute('aria-labelledby') ?? '';
    // The menu is named by the trigger, which the field label names.
    expect(labelledBy).not.toBe('');
    expect(document.getElementById(labelledBy)).toBe(trigger);
    const label = container.querySelector('label');
    expect(label?.htmlFor).toBe(labelledBy);
    expect(label?.textContent).toBe('Environment');
  });

  describe('DialogFormField help text', () => {
    const describedText = (element: Element | null): string =>
      (element?.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');

    it.each([
      ['TextInput', <TextInput key="control" id="invite-email" />, 'input'],
      ['TextArea', <TextArea key="control" id="invite-email" />, 'textarea'],
      [
        'Select',
        <Select
          key="control"
          id="invite-email"
          options={[]}
          value={null}
          onValueChange={() => undefined}
        />,
        '[role="combobox"]',
      ],
      [
        'SettingsSelect',
        <SettingsSelect
          key="control"
          id="invite-email"
          options={[{ value: 'member', label: 'Member' }]}
          value="member"
          onValueChange={() => undefined}
        />,
        '[role="combobox"]',
      ],
    ])('describes its %s with the help text', (_name, control, selector) => {
      render(
        <DialogFormField
          label="Email"
          htmlFor="invite-email"
          description="They get a link to join."
        >
          {control}
        </DialogFormField>,
      );
      expect(describedText(container.querySelector(selector))).toBe(
        'They get a link to join.',
      );
    });

    it('keeps the ids the caller already points at, once each', () => {
      render(
        <DialogFormField
          label="Email"
          htmlFor="invite-email"
          description="They get a link to join."
          error="Enter an email address."
        >
          <TextInput id="invite-email" aria-describedby="invite-email-error" />
        </DialogFormField>,
      );
      expect(describedText(container.querySelector('input'))).toBe(
        'Enter an email address. They get a link to join.',
      );
    });

    it('leaves other controls in the field undescribed', () => {
      render(
        <DialogFormField
          label="Email"
          htmlFor="invite-email"
          description="They get a link to join."
        >
          <TextInput id="invite-email" />
          <TextInput id="invite-note" />
        </DialogFormField>,
      );
      expect(
        container
          .querySelector('#invite-note')
          ?.hasAttribute('aria-describedby'),
      ).toBe(false);
    });
  });

  it('gives each DialogFormField error its own id when the caller names none', () => {
    render(
      <>
        <DialogFormField label="First" error="Choose one.">
          <span />
        </DialogFormField>
        <DialogFormField label="Second" error="Choose one.">
          <span />
        </DialogFormField>
      </>,
    );
    const ids = Array.from(container.querySelectorAll('p[id]')).map(
      (element) => element.id,
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('puts a DialogFormField error under the control, before the help text', () => {
    render(
      <DialogFormField
        label="Email"
        htmlFor="invite-email"
        description="They get a link to join."
        error="Enter an email address."
        dataTestId="invite"
      >
        <TextInput id="invite-email" aria-describedby="invite-email-error" />
      </DialogFormField>,
    );
    const order = Array.from(
      container.querySelectorAll('[data-testid="invite"] > *'),
    ).map((element) => element.textContent);
    expect(order).toEqual([
      'Email',
      '',
      'Enter an email address.',
      'They get a link to join.',
    ]);
    expect(document.getElementById('invite-email-error')?.className).toContain(
      'fg-destructive',
    );
  });

  it('shares its label and help text recipe with DialogFormField', () => {
    render(
      <>
        <FormField label="A" description="Help">
          {(control) => <TextInput {...control} />}
        </FormField>
        <DialogFormField label="B" htmlFor="b" description="Help">
          <TextInput id="b" />
        </DialogFormField>
      </>,
    );
    const [formLabel, dialogLabel] = Array.from(
      container.querySelectorAll('label'),
    );
    expect(formLabel?.className).toBe(dialogLabel?.className);
    // 13px, weight 450, primary ink (decision of 2026-10-30).
    expect(formLabel?.className.split(' ')).toEqual(
      expect.arrayContaining(['text-xs', 'font-medium', 'fg-primary']),
    );
    const [formHelp, dialogHelp] = Array.from(container.querySelectorAll('p'));
    expect(formHelp?.className).toBe(dialogHelp?.className);
  });
});
