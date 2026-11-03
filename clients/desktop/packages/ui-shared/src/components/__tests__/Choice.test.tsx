/**
 * @jest-environment jsdom
 */
import { act, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Checkbox, ChoiceMark, Radio } from '../Choice';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const tokens = (html: string, tag = 'input'): string[] =>
  (new RegExp(`<${tag}[^>]*class="([^"]*)"`).exec(html)?.[1] ?? '').split(
    /\s+/,
  );

describe('choice marks', () => {
  it('draws the native checkbox as a rounded square and the radio as a circle', () => {
    const checkbox = renderToStaticMarkup(
      <Checkbox aria-label="Agree" checked={false} readOnly />,
    );
    expect(checkbox).toContain('type="checkbox"');
    expect(tokens(checkbox)).toEqual(
      expect.arrayContaining(['appearance-none', 'rounded', 'size-4']),
    );
    expect(checkbox).not.toContain('sr-only');

    const radio = renderToStaticMarkup(
      <Radio aria-label="Pick" checked={false} readOnly />,
    );
    expect(radio).toContain('type="radio"');
    expect(tokens(radio)).toEqual(
      expect.arrayContaining(['rounded-full', 'size-4']),
    );
  });

  it('rests on a thin quiet ring and fills with the accent when selected', () => {
    const classes = tokens(
      renderToStaticMarkup(
        <Checkbox aria-label="Off" checked={false} readOnly />,
      ),
    );
    expect(classes).toEqual(
      expect.arrayContaining([
        'ring-1',
        'ring-inset',
        'ring-fg-quaternary',
        'checked:bg-accent',
        'checked:ring-0',
        'indeterminate:bg-accent',
      ]),
    );
    expect(classes).not.toContain('bg-fg-primary');
    // An unchecked radio alone in its group matches :indeterminate, so the
    // mixed look is checkbox-only.
    const radio = tokens(
      renderToStaticMarkup(<Radio aria-label="Off" checked={false} readOnly />),
    );
    expect(radio).not.toContain('indeterminate:bg-accent');
  });

  it('marks a selected radio with a dot, never a check', () => {
    const on = renderToStaticMarkup(<Radio aria-label="On" checked readOnly />);
    expect(on).toContain('data-choice-glyph="dot"');
    expect(on).not.toContain('data-glyph="check"');
    expect(on).toContain('bg-fg-emphasis');
  });

  it('marks a selected checkbox with the white check', () => {
    const on = renderToStaticMarkup(
      <Checkbox aria-label="On" checked readOnly />,
    );
    expect(on).toContain('data-glyph="check"');
    expect(on).toContain('fg-emphasis');
    expect(on).not.toContain('data-choice-glyph="dot"');
  });

  it('marks a mixed checkbox with a dash and sets the native mixed state', () => {
    const html = renderToStaticMarkup(
      <Checkbox aria-label="Some" checked={false} indeterminate readOnly />,
    );
    expect(html).toContain('data-choice-glyph="dash"');
    expect(html).not.toContain('data-glyph="check"');

    const container = document.createElement('div');
    const root = createRoot(container);
    act(() =>
      root.render(
        <Checkbox aria-label="Some" checked={false} indeterminate readOnly />,
      ),
    );
    expect(container.querySelector('input')?.indeterminate).toBe(true);
    act(() => root.render(<Checkbox aria-label="Some" checked readOnly />));
    expect(container.querySelector('input')?.indeterminate).toBe(false);
    act(() => root.unmount());
  });

  it('keeps the mixed state after a click the parent does not accept', () => {
    function SelectAll(): JSX.Element {
      const [clicks, setClicks] = useState(0);
      return (
        <Checkbox
          aria-label={`Select all (${clicks})`}
          checked={false}
          indeterminate
          // The parent re-renders but keeps the selection mixed.
          onChange={() => setClicks((count) => count + 1)}
        />
      );
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<SelectAll />));
    const input = container.querySelector('input');
    act(() => input?.click());
    expect(input?.getAttribute('aria-label')).toBe('Select all (1)');
    expect(input?.checked).toBe(false);
    expect(input?.indeterminate).toBe(true);
    act(() => root.unmount());
    container.remove();
  });

  it('owns hover, pressed, focus, and disabled states', () => {
    const classes = tokens(
      renderToStaticMarkup(<Checkbox aria-label="States" readOnly />),
    );
    expect(classes).toEqual(
      expect.arrayContaining([
        'enabled:hover:ring-fg-tertiary',
        'enabled:active:ring-fg-secondary',
        'focus-visible:shadow-field-focus',
        'disabled:cursor-not-allowed',
        'disabled:checked:bg-disabled',
      ]),
    );
    expect(classes).not.toContain('focus-ring');
  });

  it('draws a forced hover or pressed state for the fields lab with the same classes', () => {
    const html = renderToStaticMarkup(
      <Radio aria-label="Hover" checked readOnly forceState="hover" />,
    );
    expect(html).toContain('data-force-state="hover"');
    expect(tokens(html)).toContain('data-[force-state=hover]:ring-fg-tertiary');
  });

  it('keeps ChoiceMark decorative and uses the same marks', () => {
    const html = renderToStaticMarkup(
      <ChoiceMark kind="radio" checked className="mt-0.5" />,
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('<input');
    expect(html).toContain('bg-accent');
    expect(html).toContain('data-choice-glyph="dot"');
    expect(html).toContain('mt-0.5');
  });
});

describe('choice mark feedback', () => {
  it('changes hover, press and selection colors at once', () => {
    const markup = renderToStaticMarkup(<Checkbox aria-label="Mentions" />);
    expect(markup).not.toMatch(
      /transition-\[[^\]]*(box-shadow|background-color)/,
    );
    expect(markup).not.toMatch(/transition-colors|transition-all/);
  });
});
