import { renderToStaticMarkup } from 'react-dom/server';
import {
  PickerMenuOption,
  PickerMenuOptionDescription,
  PickerMenuOptionLabel,
  PickerMenuOptionLeading,
  PickerMenuOptionTrailing,
  PickerMenuTab,
  PickerTrigger,
  PickerTriggerChevron,
} from '../PickerMenu';

function classTokens(html: string): string[] {
  return (/class="([^"]*)"/.exec(html)?.[1] ?? '').split(/\s+/);
}

describe('PickerTrigger', () => {
  it('owns the disabled treatment for both variants', () => {
    const capsule = classTokens(
      renderToStaticMarkup(<PickerTrigger disabled>main</PickerTrigger>),
    );
    const field = classTokens(
      renderToStaticMarkup(
        <PickerTrigger variant="field" disabled>
          main
        </PickerTrigger>,
      ),
    );

    for (const tokens of [capsule, field]) {
      expect(tokens).toContain('disabled:cursor-not-allowed');
      expect(tokens).toContain('disabled:opacity-40');
    }
    // A disabled capsule keeps its resting secondary ink and no surface under
    // the pointer; a disabled field keeps its transparent field surface.
    expect(capsule).toContain('disabled:hover:bg-transparent');
    expect(capsule).toContain('disabled:hover:fg-secondary');
    expect(field).toContain('disabled:hover:bg-transparent');
    expect(field).not.toContain('disabled:hover:bg-base');
  });

  it('draws the field variant with the shared field edge and neutral focus', () => {
    const field = classTokens(
      renderToStaticMarkup(<PickerTrigger variant="field">main</PickerTrigger>),
    );
    const capsule = classTokens(
      renderToStaticMarkup(<PickerTrigger>main</PickerTrigger>),
    );
    expect(field).toContain('shadow-field');
    expect(field).toContain('focus-visible:shadow-field-focus');
    expect(field).toContain('rounded-lg');
    expect(field).not.toContain('focus-ring');
    expect(field).not.toContain('border');
    expect(field).not.toContain('bg-base');
    expect(capsule).toContain('focus-ring');
  });

  it('widens only a label-only capsule leading inset', () => {
    const capsule = classTokens(
      renderToStaticMarkup(<PickerTrigger labelOnly>Any source</PickerTrigger>),
    );
    expect(capsule).toContain('px-2.5');
    expect(capsule).toContain('pl-3.5');
    // A field keeps its own inset.
    const field = classTokens(
      renderToStaticMarkup(
        <PickerTrigger variant="field" labelOnly>
          main
        </PickerTrigger>,
      ),
    );
    expect(field).not.toContain('pl-3.5');
    expect(
      classTokens(renderToStaticMarkup(<PickerTrigger>main</PickerTrigger>)),
    ).not.toContain('pl-3.5');
  });

  it('sets a branch or path value in the mono face with a quieter ink', () => {
    const tokens = classTokens(
      renderToStaticMarkup(
        <PickerTrigger variant="field" mono tone="secondary">
          release/next
        </PickerTrigger>,
      ),
    );
    const plain = classTokens(
      renderToStaticMarkup(<PickerTrigger variant="field">main</PickerTrigger>),
    );

    expect(tokens).toContain('font-mono');
    expect(tokens).toContain('fg-secondary');
    expect(tokens).not.toContain('fg-primary');
    expect(plain).toContain('fg-primary');
    expect(plain).not.toContain('font-mono');
  });
});

describe('PickerTriggerChevron', () => {
  it('follows the trigger variant: quaternary in a capsule, tertiary in a field', () => {
    const capsule = classTokens(
      renderToStaticMarkup(<PickerTriggerChevron open={false} />),
    );
    const field = classTokens(
      renderToStaticMarkup(
        <PickerTriggerChevron open={false} variant="field" />,
      ),
    );

    expect(capsule).toContain('fg-quaternary');
    expect(field).toContain('fg-tertiary');
    expect(field).not.toContain('fg-quaternary');
  });
});

describe('PickerMenuOption tone and disabled ink', () => {
  it('inks an action row accent and names the group for its parts', () => {
    const accent = renderToStaticMarkup(
      <PickerMenuOption tone="accent">Connect GitHub</PickerMenuOption>,
    );
    const tokens = classTokens(accent);
    const plain = classTokens(
      renderToStaticMarkup(<PickerMenuOption>main</PickerMenuOption>),
    );

    expect(tokens).toContain('group/picker-option');
    expect(tokens).toContain('fg-accent');
    expect(tokens).not.toContain('fg-primary');
    expect(accent).toContain('data-tone="accent"');
    expect(plain).toContain('fg-primary');
    expect(plain).toContain('group/picker-option');
  });

  it('keeps a secondary row readable in the quieter ink', () => {
    const tokens = classTokens(
      renderToStaticMarkup(
        <PickerMenuOption tone="secondary">Codex</PickerMenuOption>,
      ),
    );

    expect(tokens).toContain('fg-secondary');
    expect(tokens).not.toContain('fg-primary');
  });

  it('keeps an unavailable row readable so the picker can explain it', () => {
    const tokens = classTokens(
      renderToStaticMarkup(
        <PickerMenuOption disabled>Fork PR</PickerMenuOption>,
      ),
    );

    expect(tokens).toContain('disabled:fg-quaternary');
    expect(tokens).toContain('disabled:opacity-100');
    expect(tokens).not.toContain('disabled:fg-disabled');
  });

  it('paints a locked row as unavailable while it stays activatable to explain itself', () => {
    const html = renderToStaticMarkup(
      <PickerMenuOption unavailable>Opus 4.5</PickerMenuOption>,
    );
    const tokens = classTokens(html);
    const plain = classTokens(
      renderToStaticMarkup(<PickerMenuOption>Opus 4.5</PickerMenuOption>),
    );

    // Not the control-disabled state: the row keeps its tab stop and click.
    expect(html).not.toContain('disabled=""');
    expect(tokens).toEqual(
      expect.arrayContaining([
        'cursor-not-allowed',
        'fg-secondary',
        'opacity-50',
        'hover:bg-transparent',
        'focus-visible:bg-transparent',
      ]),
    );
    expect(tokens).not.toContain('fg-primary');
    expect(plain).not.toContain('opacity-50');
    expect(plain).not.toContain('cursor-not-allowed');
  });

  it('reserves room at the trailing edge for an overlaid control', () => {
    const tokens = classTokens(
      renderToStaticMarkup(
        <PickerMenuOption trailingControl>Opus 4.5</PickerMenuOption>,
      ),
    );
    const plain = classTokens(
      renderToStaticMarkup(<PickerMenuOption>Opus 4.5</PickerMenuOption>),
    );

    expect(tokens).toContain('pr-10');
    expect(plain).not.toContain('pr-10');
  });
});

describe('PickerMenuOption parts', () => {
  it('keeps the leading rail tertiary and lets the row tone or disabled state override it', () => {
    const plain = classTokens(
      renderToStaticMarkup(<PickerMenuOptionLeading className="ml-1" />),
    );

    // A placement class no longer drops the default ink.
    expect(plain).toContain('ml-1');
    expect(plain).toContain('fg-tertiary');
    expect(plain).toContain('group-data-[tone=accent]/picker-option:fg-accent');
    expect(plain).toContain('group-disabled/picker-option:fg-quaternary');
  });

  it('offers secondary, primary, and accent leading inks, exactly one at a time', () => {
    const secondary = classTokens(
      renderToStaticMarkup(<PickerMenuOptionLeading tone="secondary" />),
    );
    const primary = classTokens(
      renderToStaticMarkup(<PickerMenuOptionLeading tone="primary" />),
    );
    const accent = classTokens(
      renderToStaticMarkup(<PickerMenuOptionLeading tone="accent" />),
    );

    expect(secondary).toContain('fg-secondary');
    expect(secondary).not.toContain('fg-tertiary');
    expect(primary).toContain('fg-primary');
    expect(primary).not.toContain('fg-tertiary');
    expect(accent).toContain('fg-accent');
    expect(accent).not.toContain('fg-tertiary');
    // A second resting ink would resolve by stylesheet order, not by the prop.
    for (const tokens of [secondary, primary, accent]) {
      expect(
        tokens.filter((token) => /^fg-/.test(token) && !token.includes(':')),
      ).toHaveLength(1);
    }
  });

  it('inks the leading rail accent for the selected mark of a plain row', () => {
    const accent = classTokens(
      renderToStaticMarkup(<PickerMenuOptionLeading tone="accent" />),
    );

    expect(accent).toContain('fg-accent');
    expect(accent).not.toContain('fg-tertiary');
  });

  it('lets a label rest one step quieter than the row without dropping to secondary', () => {
    const quiet = classTokens(
      renderToStaticMarkup(
        <PickerMenuOptionLabel tone="quiet">Opus 4.5</PickerMenuOptionLabel>,
      ),
    );
    const plain = classTokens(
      renderToStaticMarkup(
        <PickerMenuOptionLabel>Opus 4.5</PickerMenuOptionLabel>,
      ),
    );

    expect(quiet).toContain('fg-primary/80');
    expect(plain).not.toContain('fg-primary/80');
    expect(plain).not.toContain('fg-primary');
  });

  it('dims the description with the row when it is unavailable', () => {
    const tokens = classTokens(
      renderToStaticMarkup(
        <PickerMenuOptionDescription className="mt-1">
          #12 · jane
        </PickerMenuOptionDescription>,
      ),
    );

    expect(tokens).toContain('mt-1');
    expect(tokens).toContain('fg-tertiary');
    expect(tokens).toContain('group-disabled/picker-option:fg-quaternary');
  });

  it('gives the trailing slot a tertiary ink for counts and a hover ink for badges', () => {
    const quiet = classTokens(
      renderToStaticMarkup(
        <PickerMenuOptionTrailing>3</PickerMenuOptionTrailing>,
      ),
    );
    const count = classTokens(
      renderToStaticMarkup(
        <PickerMenuOptionTrailing tone="tertiary">3</PickerMenuOptionTrailing>,
      ),
    );
    const badge = classTokens(
      renderToStaticMarkup(
        <PickerMenuOptionTrailing interactive>local</PickerMenuOptionTrailing>,
      ),
    );

    expect(quiet).toContain('fg-quaternary');
    expect(quiet).not.toContain('hover:fg-secondary');
    expect(count).toContain('fg-tertiary');
    expect(count).not.toContain('fg-quaternary');
    expect(badge).toContain('fg-quaternary');
    expect(badge).toContain('hover:fg-secondary');
  });
});

describe('PickerMenuTab keyboard highlight', () => {
  it('outlines the tab the arrow keys are on and marks it for automation', () => {
    const highlighted = renderToStaticMarkup(
      <PickerMenuTab highlighted>Issues</PickerMenuTab>,
    );
    const plain = renderToStaticMarkup(<PickerMenuTab>Issues</PickerMenuTab>);

    expect(classTokens(highlighted)).toEqual(
      expect.arrayContaining([
        'outline',
        'outline-1',
        'outline-[var(--fg-accent)]',
      ]),
    );
    expect(highlighted).toContain('data-highlighted="true"');
    expect(classTokens(plain)).not.toContain('outline');
    expect(plain).not.toContain('data-highlighted');
  });
});
