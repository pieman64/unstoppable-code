import { renderToStaticMarkup } from 'react-dom/server';
import { Select, TextInput } from '../Field';
import { PickerTrigger } from '../PickerMenu';
import { SearchField } from '../SearchField';
import { SettingsSelect } from '../SettingsSelect';

/**
 * Fields and dropdowns are rounded rectangles; only buttons are capsules
 * (design decision of 2026-10-30, docs/design/forms.md). A 28px field takes
 * the 10px `rounded-row`, a 36px field the 12px `rounded-lg`.
 */
function classOf(html: string, pattern: RegExp): string {
  const match = pattern.exec(html);
  if (!match?.[1]) throw new Error(`No element matched ${pattern}`);
  return match[1];
}

const noop = (): undefined => undefined;

describe('field and dropdown shape', () => {
  it.each(['settings', 'compact'] as const)(
    'draws the 28px %s text field with 10px corners',
    (density) => {
      const cls = classOf(
        renderToStaticMarkup(<TextInput density={density} />),
        /<input[^>]*class="([^"]*)"/,
      );
      expect(cls).toContain('h-7');
      expect(cls).toContain('rounded-row');
      expect(cls).not.toContain('rounded-full');
    },
  );

  it('keeps the 36px field and select on the 12px corner', () => {
    expect(
      classOf(
        renderToStaticMarkup(<TextInput />),
        /<input[^>]*class="([^"]*)"/,
      ),
    ).toContain('rounded-lg');
    expect(
      classOf(
        renderToStaticMarkup(
          <Select options={[]} value={null} onValueChange={noop} />,
        ),
        /<button[^>]*class="([^"]*)"/,
      ),
    ).toContain('rounded-lg');
  });

  it('draws the Settings dropdown trigger as a 28px rounded rectangle', () => {
    const cls = classOf(
      renderToStaticMarkup(
        <SettingsSelect
          aria-label="Role"
          value="a"
          options={[{ value: 'a', label: 'A' }]}
          onValueChange={noop}
        />,
      ),
      /<button[^>]*class="([^"]*)"/,
    );
    expect(cls).toContain('h-7');
    expect(cls).toContain('rounded-row');
    expect(cls).not.toContain('rounded-full');
  });

  it.each(['sm', 'md'] as const)(
    'draws the %s search field as a rounded rectangle',
    (size) => {
      const cls = classOf(
        renderToStaticMarkup(
          <SearchField
            size={size}
            value=""
            onValueChange={noop}
            aria-label="Search"
          />,
        ),
        /(<[^>]*data-search-field="[a-z]+"[^>]*>)/,
      ).replace(/^.*\sclass="([^"]*)".*$/s, '$1');
      expect(cls).toContain('rounded-row');
      expect(cls).not.toContain('rounded-full');
    },
  );

  it('draws the field picker trigger with the 10px corner', () => {
    const cls = classOf(
      renderToStaticMarkup(
        <PickerTrigger variant="field">Branch</PickerTrigger>,
      ),
      /<button[^>]*class="([^"]*)"/,
    );
    expect(cls).toContain('rounded-row');
    expect(cls).not.toContain('rounded-full');
  });
});
