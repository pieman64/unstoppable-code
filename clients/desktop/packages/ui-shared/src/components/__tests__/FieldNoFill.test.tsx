import { renderToStaticMarkup } from 'react-dom/server';
import { Select, TextArea, TextInput } from '../Field';
import { InlineTextInput } from '../InlineTextInput';
import { SearchField } from '../SearchField';

/**
 * A text field never fills on hover or focus (Daniil, 2026-11-02): it keeps
 * its resting surface and shows focus with the edge and halo only.
 */
const noop = (): undefined => undefined;

/** Hover, focus and focus-within states that would paint a background. */
const STATE_FILL =
  /^(?:hover|focus|focus-visible|focus-within|has-\[input:focus\]):(?:bg-|\[background)/;

function classes(html: string, pattern: RegExp): string[] {
  const match = pattern.exec(html);
  if (!match?.[1]) throw new Error(`No match in ${html}`);
  return match[1].split(/\s+/);
}

function stateFills(tokens: readonly string[]): string[] {
  return tokens.filter((token) => STATE_FILL.test(token));
}

describe('text fields keep their surface on hover and focus', () => {
  it('TextInput and TextArea: transparent, focus edge only, disabled fill kept', () => {
    for (const html of [
      renderToStaticMarkup(<TextInput />),
      renderToStaticMarkup(<TextInput density="compact" />),
      renderToStaticMarkup(<TextInput density="settings" />),
      renderToStaticMarkup(<TextArea />),
    ]) {
      const tokens = classes(html, /class="([^"]*)"/);
      expect(tokens).toContain('bg-transparent');
      expect(stateFills(tokens)).toEqual([]);
      expect(tokens).toContain('focus-visible:shadow-field-focus');
      expect(tokens).toContain('disabled:bg-disabled');
    }
  });

  it('the box of an adorned TextInput', () => {
    const box = classes(
      renderToStaticMarkup(<TextInput leading="@" />),
      /<span[^>]*class="([^"]*)"/,
    );
    expect(stateFills(box)).toEqual([]);
    expect(box).toContain('has-[input:focus]:shadow-field-focus');
  });

  it('SearchField at every size', () => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const box = classes(
        renderToStaticMarkup(
          <SearchField
            size={size}
            value=""
            onValueChange={noop}
            aria-label="Search"
          />,
        ),
        /data-search-field="[a-z]+"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*data-search-field=/,
      );
      expect(stateFills(box)).toEqual([]);
    }
  });

  it('InlineTextInput: no hover fill, no editing fill', () => {
    const inline = classes(
      renderToStaticMarkup(
        <InlineTextInput aria-label="Title" value="A" onCommit={noop} />,
      ),
      /<input[^>]*class="([^"]*)"/,
    );
    expect(inline).toContain('bg-transparent');
    expect(stateFills(inline)).toEqual([]);
    expect(inline).toContain('focus:shadow-field-focus');
  });

  it('the Select trigger keeps its dropdown hover and press, with no focus or open fill', () => {
    const trigger = classes(
      renderToStaticMarkup(
        <Select options={[]} value={null} onValueChange={noop} />,
      ),
      /<button[^>]*class="([^"]*)"/,
    );
    expect(trigger).not.toContain('focus-visible:bg-base');
    expect(trigger).not.toContain('aria-expanded:bg-base');
    // A dropdown trigger, not a text field: the button's hover and press stay.
    expect(trigger).toContain('active:scale-97');
    expect(trigger.some((token) => token.startsWith('hover:'))).toBe(true);
  });
});
