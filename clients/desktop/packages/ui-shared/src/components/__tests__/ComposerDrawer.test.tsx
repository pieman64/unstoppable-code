/**
 * @jest-environment jsdom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ComposerDrawer, ComposerDrawerSection } from '../ComposerDrawer';

const SECTION_DIVIDER = '[[data-composer-drawer-section]~&]:border-t';
const EMPTY_COLLAPSE = '[&:not(:has([data-composer-drawer-section]))]:contents';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: ReactNode): void {
  act(() => root.render(node));
}

function byTestId(id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (element === null) throw new Error(`No element with test id ${id}`);
  return element;
}

describe('ComposerDrawer', () => {
  it('tucks a top drawer under the composer, keeping a 4px inset', () => {
    render(
      <ComposerDrawer edge="top" data-testid="drawer">
        <ComposerDrawerSection>Pickers</ComposerDrawerSection>
      </ComposerDrawer>,
    );
    const drawer = byTestId('drawer');
    expect(drawer.tagName).toBe('DIV');
    expect(drawer.dataset.composerDrawer).toBe('top');
    for (const name of [
      'relative',
      'mx-4',
      'bg-depth',
      'p-1',
      'shadow-2xs',
      '-mb-4',
      'rounded-t-2xl',
      'pb-5',
    ]) {
      expect(drawer.classList).toContain(name);
    }
    expect(drawer.classList).not.toContain('rounded-b-2xl');
  });

  it('hangs a bottom drawer under the composer as a labelled region', () => {
    render(
      <ComposerDrawer
        edge="bottom"
        as="section"
        aria-labelledby="summary"
        className="z-10"
        data-testid="drawer"
      >
        <ComposerDrawerSection>
          <p id="summary">Sign in</p>
        </ComposerDrawerSection>
      </ComposerDrawer>,
    );
    const drawer = byTestId('drawer');
    expect(drawer.tagName).toBe('SECTION');
    expect(drawer.getAttribute('aria-labelledby')).toBe('summary');
    for (const name of ['rounded-b-2xl', 'z-10', 'shadow-2xs']) {
      expect(drawer.classList).toContain(name);
    }
    expect(drawer.classList).not.toContain('-mb-4');
    expect(drawer.classList).not.toContain('pb-5');
  });

  it('collapses to its children while no section renders', () => {
    render(
      <ComposerDrawer edge="top" data-testid="drawer">
        <span data-testid="marker" />
      </ComposerDrawer>,
    );
    expect(byTestId('drawer').classList).toContain(EMPTY_COLLAPSE);
    expect(byTestId('marker').parentElement).toBe(byTestId('drawer'));
  });

  it('keeps borders off the elevated surface', () => {
    render(
      <ComposerDrawer edge="top" data-testid="drawer">
        <ComposerDrawerSection>One</ComposerDrawerSection>
      </ComposerDrawer>,
    );
    expect(byTestId('drawer').className).not.toMatch(/border/);
  });
});

describe('ComposerDrawerSection', () => {
  it('marks its block and draws the divider only after another section', () => {
    render(
      <ComposerDrawer edge="top">
        <ComposerDrawerSection data-testid="first" className="flex">
          Tip
        </ComposerDrawerSection>
        <ComposerDrawerSection data-testid="second">
          Background
        </ComposerDrawerSection>
      </ComposerDrawer>,
    );
    const first = byTestId('first');
    const second = byTestId('second');
    expect(first.dataset.composerDrawerSection).toBe('');
    expect(first.classList).toContain('flex');
    // The divider is a sibling selector, so only a later section matches it.
    for (const section of [first, second]) {
      expect(section.classList).toContain(SECTION_DIVIDER);
    }
    expect(second.matches('[data-composer-drawer-section] ~ *')).toBe(true);
    expect(first.matches('[data-composer-drawer-section] ~ *')).toBe(false);
  });
});
