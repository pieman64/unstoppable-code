/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { ActionMenuShortcut } from '../ActionMenuItems';
import { Button } from '../Button';
import { Kbd } from '../Kbd';
import { KbdChip } from '../KbdChip';
import { KeyHintFooter } from '../KeyHintFooter';
import { pickerKeyHints } from '../../lib/shortcuts';
import { SidebarNavRow } from '../SidebarNavRow';
import { SIDEBAR_NAV_ROW_TRAILING_INSET_CLASSNAME } from '../sidebar-item-classes';

function parse(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

describe('Kbd', () => {
  it('draws one filled, borderless capsule per key', () => {
    const host = parse(renderToStaticMarkup(<Kbd shortcut="⌘⇧K" />));
    const caps = Array.from(host.querySelectorAll('kbd'));
    expect(caps.map((cap) => cap.textContent)).toEqual(['⌘', '⇧', 'K']);
    for (const cap of caps) {
      expect(cap.className).toContain('rounded-full');
      expect(cap.className).toContain('bg-muted');
      expect(cap.className).not.toMatch(/(^|\s)border(\s|$)/);
    }
    // The wrapper is not itself a key, so a hint has exactly one kbd per key.
    expect(host.firstElementChild?.tagName).toBe('SPAN');
  });

  it('takes keys in press order as well as a display string', () => {
    const host = parse(
      renderToStaticMarkup(<Kbd shortcut={['Ctrl', 'Shift', 'K']} />),
    );
    expect(
      Array.from(host.querySelectorAll('kbd')).map((cap) => cap.textContent),
    ).toEqual(['Ctrl', 'Shift', 'K']);
  });

  it('scales modifier glyphs and lifts descending glyphs', () => {
    const host = parse(renderToStaticMarkup(<Kbd shortcut="⌘\\" />));
    const glyphs = Array.from(host.querySelectorAll('kbd > span'));
    expect(glyphs[0]?.className).toContain('text-xs');
    expect(glyphs[1]?.className).toContain('-translate-y-px');
  });

  it('can be hidden from assistive technology', () => {
    const host = parse(
      renderToStaticMarkup(<Kbd shortcut="A" aria-hidden data-testid="x" />),
    );
    const wrapper = host.querySelector('[data-testid="x"]');
    expect(wrapper?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Button shortcut', () => {
  it('draws the shortcut inside the button as one chip, outside its name', () => {
    const host = parse(
      renderToStaticMarkup(
        <Button size="sm" shortcut="⌘P">
          Open file
        </Button>,
      ),
    );
    const button = host.querySelector('button');
    const chip = button?.querySelector('[data-testid="kbd-chip"]');
    expect(chip).toBeInstanceOf(Element);
    expect(chip?.textContent).toBe('⌘P');
    expect(chip?.getAttribute('aria-hidden')).toBe('true');
    expect(chip?.className).toContain('rounded-full');
    expect(chip?.className).not.toMatch(/(^|\s)border(\s|$)/);
    // The chip trails the label.
    expect(button?.lastElementChild).toBe(chip);
    // The end padding nests the chip's capsule in the button's end cap:
    // (28px - 18px) / 2 = 5px on the small size.
    expect(button?.className).toContain('pr-1.25');
  });

  it('nests the chip in each size by its own end cap', () => {
    const endPadding = (size: 'md' | 'lg'): string | undefined =>
      parse(
        renderToStaticMarkup(
          <Button size={size} shortcut="⌘K">
            Search
          </Button>,
        ),
      )
        .querySelector('button')
        ?.className.split(/\s+/)
        .find((name) => name.startsWith('pr-'));
    expect(endPadding('md')).toBe('pr-1.75');
    expect(endPadding('lg')).toBe('pr-2.25');
  });

  it('adds nothing without a shortcut', () => {
    const host = parse(renderToStaticMarkup(<Button>Open file</Button>));
    expect(host.querySelector('[data-testid="kbd-chip"]')).toBeNull();
    expect(host.querySelector('button')?.className).not.toContain('pr-1');
    const empty = parse(renderToStaticMarkup(<Button shortcut="">Go</Button>));
    expect(empty.querySelector('[data-testid="kbd-chip"]')).toBeNull();
  });

  it('derives the chip ink from the button so it reads on any variant', () => {
    const chip = parse(
      renderToStaticMarkup(<KbdChip shortcut="⌘↵" />),
    ).firstElementChild;
    expect(chip?.className).toContain('bg-current/10');
  });
});

describe('KeyHintFooter', () => {
  it('names each key with a one-word verb, in the picker order', () => {
    const host = parse(
      renderToStaticMarkup(
        <KeyHintFooter hints={pickerKeyHints('open', 'mac')} />,
      ),
    );
    const footer = host.querySelector('[data-testid="key-hint-footer"]');
    expect(footer?.textContent).toBe('↑↓move↵openescclose');
    expect(footer?.querySelectorAll('kbd')).toHaveLength(4);
  });

  it('uses the Windows and Linux words off macOS', () => {
    expect(pickerKeyHints('attach', 'other')).toEqual([
      { shortcut: ['↑', '↓'], label: 'move' },
      { shortcut: ['Enter'], label: 'attach' },
      { shortcut: ['Esc'], label: 'close' },
    ]);
  });
});

describe('row shortcut glyphs', () => {
  it('trails a sidebar row label as plain quaternary glyphs', () => {
    const host = parse(
      renderToStaticMarkup(
        <SidebarNavRow icon={null} shortcut="⌘N">
          New task
        </SidebarNavRow>,
      ),
    );
    const glyphs = host.querySelector('[data-testid="sidebar-row-shortcut"]');
    expect(glyphs?.textContent).toBe('⌘N');
    expect(glyphs?.className).toContain('ml-auto');
    expect(glyphs?.className).toContain('fg-quaternary');
    expect(glyphs?.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('kbd')).toBeNull();
    // Hidden at rest but still laid out, shown on hover or keyboard focus.
    const row = host.querySelector('button');
    expect(row?.className).toContain('group/nav-row');
    expect(glyphs?.className).toContain('opacity-0');
    expect(glyphs?.className).not.toMatch(/\b(hidden|invisible)\b/);
    expect(glyphs?.className).toContain('group-hover/nav-row:opacity-100');
    expect(glyphs?.className).toContain(
      'group-focus-visible/nav-row:opacity-100',
    );
    expect(glyphs?.className).toContain('motion-reduce:transition-none');
    // Its right edge is the trailing cell's, through the shared inset.
    expect(glyphs?.className).toContain(
      SIDEBAR_NAV_ROW_TRAILING_INSET_CLASSNAME,
    );
    const plain = parse(
      renderToStaticMarkup(<SidebarNavRow icon={null}>Search</SidebarNavRow>),
    );
    expect(
      plain.querySelector('[data-testid="sidebar-row-shortcut"]'),
    ).toBeNull();
  });

  it('draws a menu row shortcut in the quietest ink, not as caps', () => {
    const host = parse(
      renderToStaticMarkup(<ActionMenuShortcut shortcut="⌘ Click" />),
    );
    const glyphs = host.firstElementChild;
    expect(glyphs?.textContent).toBe('⌘ Click');
    expect(glyphs?.className).toContain('fg-quaternary');
    expect(host.querySelector('kbd')).toBeNull();
  });
});
