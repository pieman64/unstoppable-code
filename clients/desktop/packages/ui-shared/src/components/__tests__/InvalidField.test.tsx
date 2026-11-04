import { renderToStaticMarkup } from 'react-dom/server';
import { Select, TextArea, TextInput } from '../Field';
import { SettingsSelect } from '../SettingsSelect';
import { InlineTextInput } from '../InlineTextInput';

/**
 * An invalid field keeps one colour family (designer feedback, 2026-10-30):
 * the destructive edge at rest and a destructive edge and halo while
 * focused, replacing the grey focus rather than stacking a red ring under
 * it.
 */
const noop = (): undefined => undefined;

function firstClass(html: string, tag: string): string[] {
  const match = new RegExp(`<${tag}[^>]*class="([^"]*)"`).exec(html);
  if (!match?.[1]) throw new Error(`No <${tag}> in ${html}`);
  return match[1].split(/\s+/);
}

const SELF = [
  'aria-invalid:shadow-field-invalid',
  'aria-invalid:focus-visible:shadow-field-invalid-focus',
];

describe('invalid field', () => {
  it.each(['default', 'compact', 'settings'] as const)(
    'gives the %s TextInput the destructive edge and destructive focus',
    (density) => {
      const classes = firstClass(
        renderToStaticMarkup(<TextInput density={density} aria-invalid />),
        'input',
      );
      expect(classes).toEqual(expect.arrayContaining(SELF));
      // No extra inset ring stacked on the edge.
      expect(classes).not.toContain('ring-line-destructive');
      expect(classes).not.toContain('ring-1');
    },
  );

  it('treats TextArea and the Select trigger the same way', () => {
    expect(
      firstClass(renderToStaticMarkup(<TextArea aria-invalid />), 'textarea'),
    ).toEqual(expect.arrayContaining(SELF));
    expect(
      firstClass(
        renderToStaticMarkup(
          <Select
            options={[]}
            value={null}
            onValueChange={noop}
            aria-invalid
          />,
        ),
        'button',
      ),
    ).toEqual(expect.arrayContaining(SELF));
  });

  // Focus moves into the open menu, so the open trigger draws the focus
  // edge itself, as the 28px dropdowns do.
  it('keeps the focus edge on an open Select trigger, destructive when invalid', () => {
    expect(
      firstClass(
        renderToStaticMarkup(
          <Select options={[]} value={null} onValueChange={noop} />,
        ),
        'button',
      ),
    ).toEqual(
      expect.arrayContaining([
        'aria-expanded:shadow-field-focus',
        'aria-invalid:aria-expanded:shadow-field-invalid-focus',
      ]),
    );
  });

  it('draws it on the box of an adorned TextInput', () => {
    const html = renderToStaticMarkup(
      <TextInput density="settings" leading="@" aria-invalid />,
    );
    expect(firstClass(html, 'span')).toEqual(
      expect.arrayContaining([
        'has-[input[aria-invalid=true]]:shadow-field-invalid',
        'has-[input[aria-invalid=true]:focus]:shadow-field-invalid-focus',
      ]),
    );
  });

  it('marks an invalid inline edit too', () => {
    expect(
      firstClass(
        renderToStaticMarkup(
          <InlineTextInput
            aria-label="Title"
            value=""
            onCommit={noop}
            aria-invalid
          />,
        ),
        'input',
      ),
    ).toEqual(
      expect.arrayContaining([
        'aria-invalid:shadow-field-invalid',
        'aria-invalid:focus:shadow-field-invalid-focus',
      ]),
    );
  });

  it('gives the 28px Settings dropdown the same edge and focus through aria-invalid', () => {
    const dropdown = [
      'aria-invalid:ring-0',
      'aria-invalid:shadow-field-invalid',
      'aria-invalid:focus-visible:shadow-field-invalid-focus',
      'aria-invalid:aria-expanded:shadow-field-invalid-focus',
    ];
    const settings = renderToStaticMarkup(
      <SettingsSelect
        aria-label="Role"
        options={[{ value: 'a', label: 'A' }]}
        value={null}
        onValueChange={noop}
        aria-invalid
      />,
    );
    expect(settings).toContain('aria-invalid="true"');
    expect(firstClass(settings, 'button')).toEqual(
      expect.arrayContaining(dropdown),
    );
  });
});
