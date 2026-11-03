/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FieldError,
  Select,
  TextArea,
  TextInput,
  type SelectOption,
} from '../Field';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const OPTIONS: readonly SelectOption[] = [
  { value: 'staging', label: 'Staging' },
  { value: 'production', label: 'Production' },
  { value: 'preview', label: 'Preview', disabled: true },
];

describe('form fields', () => {
  it('offers a 28px rounded field for Settings without changing regular fields', () => {
    const html = renderToStaticMarkup(
      <TextInput
        density="settings"
        type="number"
        min={1}
        max={90}
        defaultValue={7}
      />,
    );
    expect(html).toContain('h-7 rounded-row px-2.5');
    expect(html).toContain('whitespace-nowrap placeholder:whitespace-nowrap');
    expect(html).toContain('shadow-field');
    expect(html).toContain('focus-visible:shadow-field-focus');
    expect(html).toContain('value="7"');
    expect(html).not.toContain('density=');
    expect(renderToStaticMarkup(<TextInput density="compact" />)).toContain(
      'rounded-row',
    );
  });
  it('draws every field with the token edge and neutral focus, not an outline ring', () => {
    for (const html of [
      renderToStaticMarkup(<TextInput placeholder="Name" />),
      renderToStaticMarkup(<TextArea placeholder="Notes" />),
      renderToStaticMarkup(
        <Select
          aria-label="Environment"
          options={OPTIONS}
          value={null}
          onValueChange={(): void => undefined}
        />,
      ),
    ]) {
      expect(html).toContain('shadow-field');
      expect(html).toContain('focus-visible:shadow-field-focus');
      expect(html).toContain('outline-none');
      expect(html).not.toContain('focus-ring');
      expect(html).not.toMatch(/\bborder\b/);
      expect(html).toContain('rounded-lg');
      expect(html).toContain('px-3 py-2');
      expect(html).toContain('min-h-9');
      expect(html).toContain('text-s');
    }
  });

  it('keeps typed values on normal wrapping while placeholders stay pretty', () => {
    const html = renderToStaticMarkup(<TextArea placeholder="Notes" />);
    expect(html).toContain('text-wrap');
    expect(html).toContain('placeholder:text-pretty');
  });

  it('defaults TextInput to a text field', () => {
    const html = renderToStaticMarkup(<TextInput />);
    expect(html).toContain('type="text"');
    expect(renderToStaticMarkup(<TextInput type="number" />)).toContain(
      'type="number"',
    );
  });

  it('gives TextArea two rows, vertical resizing, and the inset grip', () => {
    const html = renderToStaticMarkup(<TextArea />);
    expect(html).toContain('rows="2"');
    expect(html).toContain('resize-y');
    expect(html).toContain('field-resize-grip');
  });

  it('sets a TextArea in monospace for code', () => {
    const html = renderToStaticMarkup(<TextArea mono rows={4} />);
    expect(html).toContain('rows="4"');
    expect(html).toContain('font-mono');
    expect(html).toContain('field-resize-grip');
    expect(renderToStaticMarkup(<TextArea />)).not.toContain('font-mono');
  });

  it('draws a Canopy select: a field trigger with the app chevron, not a native select', () => {
    const html = renderToStaticMarkup(
      <Select
        aria-label="Environment"
        options={OPTIONS}
        value={null}
        onValueChange={(): void => undefined}
        className="max-w-60"
      />,
    );
    expect(html).not.toContain('<select');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-app-icon');
    // Nothing chosen: the placeholder in the tertiary ink.
    expect(html).toContain('Choose an option');
    expect(html).toContain('fg-tertiary');
    // Placement classes land on the wrapper, not on the field recipe.
    expect(html).toMatch(/<span class="relative flex w-full max-w-60">/);
  });

  describe('interaction', () => {
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

    function trigger(): HTMLButtonElement {
      const element = container.querySelector('[role="combobox"]');
      if (!(element instanceof HTMLButtonElement)) {
        throw new Error('missing trigger');
      }
      return element;
    }

    function option(label: string): HTMLButtonElement {
      const element = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
      ).find((candidate) => candidate.textContent === label);
      if (!element) throw new Error(`missing option ${label}`);
      return element;
    }

    it('opens a listbox, marks the chosen option, and reports a new choice', () => {
      const onValueChange = jest.fn();
      act(() =>
        root.render(
          <Select
            aria-label="Environment"
            options={OPTIONS}
            value="staging"
            onValueChange={onValueChange}
          />,
        ),
      );
      expect(trigger().textContent).toBe('Staging');
      expect(document.querySelector('[role="listbox"]')).toBeNull();

      act(() => trigger().click());
      expect(trigger().getAttribute('aria-expanded')).toBe('true');
      const listbox = document.querySelector('[role="listbox"]');
      expect(listbox?.getAttribute('aria-label')).toBe('Environment');
      expect(trigger().getAttribute('aria-controls')).toBe(listbox?.id);
      expect(option('Staging').getAttribute('aria-selected')).toBe('true');
      expect(option('Production').getAttribute('aria-selected')).toBe('false');
      expect(option('Preview').disabled).toBe(true);

      act(() => option('Production').click());
      expect(onValueChange).toHaveBeenCalledWith('production');
      expect(document.querySelector('[role="listbox"]')).toBeNull();
    });

    it('does not open while disabled', () => {
      act(() =>
        root.render(
          <Select
            aria-label="Environment"
            options={OPTIONS}
            value={null}
            onValueChange={(): void => undefined}
            disabled
          />,
        ),
      );
      act(() => trigger().click());
      expect(document.querySelector('[role="listbox"]')).toBeNull();
    });

    it('closes when disabled while open and stays closed when enabled again', () => {
      const onValueChange = jest.fn();
      const renderSelect = (disabled: boolean): void =>
        act(() =>
          root.render(
            <Select
              aria-label="Environment"
              options={OPTIONS}
              value="staging"
              onValueChange={onValueChange}
              disabled={disabled}
            />,
          ),
        );
      renderSelect(false);
      act(() => trigger().click());
      expect(document.querySelector('[role="listbox"]')).not.toBeNull();

      renderSelect(true);
      expect(document.querySelector('[role="listbox"]')).toBeNull();
      expect(trigger().getAttribute('aria-expanded')).toBe('false');

      renderSelect(false);
      expect(document.querySelector('[role="listbox"]')).toBeNull();
      expect(onValueChange).not.toHaveBeenCalled();
    });
  });

  describe('adorned TextInput', () => {
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

    const press = (target: Element | null): MouseEvent => {
      const event = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        target?.dispatchEvent(event);
      });
      return event;
    };

    it('focuses the input on a press on an adornment or the padding', () => {
      act(() =>
        root.render(
          <TextInput
            aria-label="Retention"
            leading="@"
            trailing="days"
            defaultValue="7"
          />,
        ),
      );
      const input = container.querySelector('input');
      for (const target of [
        container.querySelector('[data-field-adornment="leading"]'),
        container.querySelector('[data-field-adornment="trailing"]'),
        input?.parentElement ?? null,
      ]) {
        input?.blur();
        expect(press(target).defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(input);
      }
    });

    it('leaves a press on a control inside an adornment to that control', () => {
      act(() =>
        root.render(
          <TextInput
            aria-label="Token"
            trailing={<button type="button">Show</button>}
          />,
        ),
      );
      const event = press(container.querySelector('button'));
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).not.toBe(container.querySelector('input'));
    });
  });

  it('appends caller placement classes without dropping the recipe', () => {
    const html = renderToStaticMarkup(<TextInput className="max-w-60" />);
    expect(html).toContain('shadow-field');
    expect(html).toContain('max-w-60');
  });

  it('draws the FieldError glyph at a true 12px, centred on the first line', () => {
    const html = renderToStaticMarkup(
      <FieldError id="name-error">Enter a name.</FieldError>,
    );
    const svg = /<svg[^>]*>/.exec(html)?.[0] ?? '';
    // The Badge recipe: an exact 12px glyph (no snap to 14px) with the 1.5px
    // drawn stroke of the small icons.
    expect(svg).toContain('width:12px;height:12px');
    expect(svg).toContain('data-icon-size="exact"');
    // 3 units of the 24-unit artwork drawn at 12px is a 1.5px stroke.
    expect(svg).toContain('stroke-width:3');
    // The glyph box is one 18px line of the 13px text, so the icon sits on
    // the first line's centre.
    expect(html).toContain('h-4.5');
    expect(html).toContain('gap-1 ');
  });
});
