/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { Checkbox, ChoiceMark, Radio } from '../Choice';

describe('choice marks', () => {
  it('draws the native checkbox and radio as the mark', () => {
    const checkbox = renderToStaticMarkup(
      <Checkbox aria-label="Agree" checked={false} readOnly />,
    );
    expect(checkbox).toContain('type="checkbox"');
    expect(checkbox).toContain('appearance-none');
    expect(checkbox).toContain('rounded');
    expect(checkbox).not.toContain('sr-only');

    const radio = renderToStaticMarkup(
      <Radio aria-label="Pick" checked={false} readOnly />,
    );
    expect(radio).toContain('type="radio"');
    expect(radio).toContain('rounded-full');
  });

  it('uses a 1px quaternary edge when unchecked and a neutral fill when checked', () => {
    const off = renderToStaticMarkup(
      <Checkbox aria-label="Off" checked={false} readOnly />,
    );
    expect(off).toContain('ring-1 ring-inset');
    expect(off).toContain('ring-fg-quaternary');
    expect(off).not.toContain('bg-fg-primary');

    const on = renderToStaticMarkup(
      <Checkbox aria-label="On" checked readOnly />,
    );
    expect(on).toContain('bg-fg-primary');
    expect(on).toContain('[color:var(--bg-base)]');
    expect(on).not.toContain('bg-accent');
  });

  it('draws the app checkmark at 14px', () => {
    const on = renderToStaticMarkup(<Radio aria-label="On" checked readOnly />);
    expect(on).toContain('data-app-icon');
    expect(on).toContain('data-glyph="check"');
    expect(on).toContain('width:14px');
  });

  it('shows the neutral focus halo, not an accent ring', () => {
    const html = renderToStaticMarkup(
      <Checkbox aria-label="Focus" checked={false} readOnly />,
    );
    expect(html).toContain('focus-visible:shadow-field-focus');
    expect(html).not.toContain('focus-ring');
  });

  it('keeps ChoiceMark decorative for rows that are the control', () => {
    const html = renderToStaticMarkup(
      <ChoiceMark kind="checkbox" checked className="mt-0.5" />,
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('<input');
    expect(html).toContain('bg-fg-primary');
    expect(html).toContain('mt-0.5');
  });
});
