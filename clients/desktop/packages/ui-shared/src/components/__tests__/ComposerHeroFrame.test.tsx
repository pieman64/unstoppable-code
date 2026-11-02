/** @jest-environment jsdom */
import { act, type JSX, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ComposerHeroFrame } from '../ComposerHeroFrame';
import { HomeSection } from '../HomeSection';

/** Opens the section's ••• menu and picks Hide section. */
function clickHideSection(root: ParentNode = document): void {
  const trigger = root.querySelector<HTMLButtonElement>(
    '[data-testid^="home-section-more-"]',
  );
  if (!trigger) throw new Error('Missing section menu');
  trigger.focus();
  act(() => trigger.click());
  const menu = document.getElementById(
    trigger.getAttribute('aria-controls') ?? '',
  );
  const hide = menu?.querySelector<HTMLElement>(
    '[data-testid^="home-section-hide-"]',
  );
  if (!hide) throw new Error('Missing Hide section');
  act(() => hide.click());
}

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function byTestId(container: HTMLElement, id: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!node) throw new Error(`missing ${id}`);
  return node;
}

describe('ComposerHeroFrame', () => {
  let container: HTMLDivElement;
  let root: Root;
  const rectHeight = new Map<string, number>();

  beforeEach(() => {
    rectHeight.clear();
    jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function rect(this: HTMLElement): DOMRect {
        return new DOMRect(
          0,
          0,
          100,
          rectHeight.get(this.dataset.testid ?? '') ?? 0,
        );
      });
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.restoreAllMocks();
  });

  it('returns focus to the composer when no section survives restoration', () => {
    document.body.append(container);
    const renderSections = (visible: boolean): void => {
      act(() =>
        root.render(
          <ComposerHeroFrame
            rhythm="spacious"
            composer={<textarea aria-label="Draft" />}
            below={
              visible ? (
                <HomeSection sectionId="readiness" title="Project suggestions">
                  Fix project
                </HomeSection>
              ) : null
            }
          />,
        ),
      );
    };
    renderSections(true);
    clickHideSection(container);
    renderSections(false);
    const restore = container.querySelector<HTMLButtonElement>('button');
    if (!restore) throw new Error('Missing restore action');
    restore.focus();
    act(() => restore.click());
    expect(document.activeElement).toBe(
      container.querySelector('[role="group"][aria-label="Chat composer"]'),
    );
  });

  function render(rhythm: 'spacious' | 'compact'): void {
    act(() =>
      root.render(
        <ComposerHeroFrame
          rhythm={rhythm}
          anchorTestId="anchor"
          groupTestId="group"
          shellTestId="shell"
          hangingTestId="hanging"
          above={<h1>Heading</h1>}
          composer={<div data-testid="composer" />}
          hanging={<p>Sign in to Linear</p>}
          below={<p data-testid="row">Suggestion</p>}
        />,
      ),
    );
  }

  // Nothing around the composer can move it: the heading and anything at its
  // bottom edge hang out of flow, and its midpoint sits on the frame's centre.
  it('pins the composer to the centre with the heading and edge content out of flow', () => {
    render('spacious');

    expect(byTestId(container, 'anchor').className).toContain('h-48');
    const group = byTestId(container, 'group');
    expect(group.className).toContain('absolute');
    expect(group.className).toContain('top-1/2');
    const shell = byTestId(container, 'shell');
    expect(shell.className).toContain('-translate-y-1/2');
    expect(shell.querySelector('h1')?.parentElement?.className).toContain(
      'bottom-full',
    );
    // Everything under the composer hangs from its bottom edge in one
    // column: the edge content first, then the rows.
    const rows = byTestId(container, 'row').parentElement;
    const column = rows?.parentElement;
    expect(column?.parentElement).toBe(shell);
    expect(column?.className).toContain('absolute');
    expect(column?.className).toContain('top-full');
    expect(column?.firstElementChild).toBe(byTestId(container, 'hanging'));
    expect(column?.lastElementChild).toBe(rows);
  });

  it('uses the desktop Home rhythm or the web hero rhythm', () => {
    const rows = (): string =>
      byTestId(container, 'row').parentElement?.className ?? '';

    render('spacious');
    expect(byTestId(container, 'group').className).toContain('px-6');
    expect(rows()).toContain('mt-16');
    expect(rows()).toContain('gap-12');

    render('compact');
    expect(byTestId(container, 'group').className).not.toContain('px-6');
    expect(rows()).toContain('mt-5');
    expect(rows()).toContain('gap-12');
  });

  // The server HTML already has the final geometry: nothing is measured or
  // set after hydration, which on web moved the rows after the first paint.
  it('positions everything with CSS alone', () => {
    rectHeight.set('shell', 120);
    rectHeight.set('hanging', 40);
    render('compact');

    expect(container.querySelector('[style]')).toBeNull();
  });

  // The web hero switches layout with the layout tier. The composer holds the
  // visitor's draft and focus, so the switch must restyle the frame around it
  // rather than remount it.
  it('keeps the composer mounted across a layout switch', () => {
    const mounts: number[] = [];
    function Composer(): JSX.Element {
      useState(() => mounts.push(mounts.length + 1));
      return <div data-testid="composer" />;
    }
    const renderAs = (layout: 'centred' | 'column'): void =>
      act(() =>
        root.render(
          <ComposerHeroFrame
            rhythm="compact"
            layout={layout}
            anchorTestId="anchor"
            groupTestId="group"
            shellTestId="shell"
            above={<h1>Heading</h1>}
            composer={<Composer />}
            below={<p data-testid="row">Suggestion</p>}
          />,
        ),
      );

    renderAs('centred');
    renderAs('column');
    expect(byTestId(container, 'anchor').className).toContain('flex-col');
    expect(byTestId(container, 'anchor').className).not.toContain('h-48');
    // The centring wrappers drop out of layout, so the heading, composer and
    // rows are the column's own flex items.
    expect(byTestId(container, 'group').className).toBe('contents');
    expect(byTestId(container, 'shell').className).toBe('contents');
    expect(byTestId(container, 'row').parentElement?.className).toBe(
      'contents',
    );
    renderAs('centred');

    expect(mounts).toEqual([1]);
  });
});
