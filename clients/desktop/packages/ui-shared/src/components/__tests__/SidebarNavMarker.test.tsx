/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExperimentIcon, WrenchIcon } from '../../icons/AppIcons';
import {
  SidebarNavMarker,
  SIDEBAR_NAV_MARKER_TOOLTIPS,
} from '../SidebarNavMarker';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: JSX.Element): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function marker(container: HTMLElement, testId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (!element) {
    throw new Error(`${testId} not found`);
  }
  return element;
}

describe('SidebarNavMarker', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('names a dev page Dev and a Labs page Labs, with no visible text', () => {
    const { container, root } = render(
      <>
        <SidebarNavMarker kind="dev" />
        <SidebarNavMarker kind="labs" />
      </>,
    );

    const dev = marker(container, 'sidebar-entry-marker-dev');
    const labs = marker(container, 'sidebar-entry-marker-labs');
    expect(dev.getAttribute('role')).toBe('img');
    expect(dev.getAttribute('aria-label')).toBe('Dev');
    expect(labs.getAttribute('role')).toBe('img');
    expect(labs.getAttribute('aria-label')).toBe('Labs');
    expect(dev.textContent).toBe('');
    expect(labs.textContent).toBe('');
    expect(dev.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    act(() => root.unmount());
  });

  it('draws a muted 16px glyph pushed to the row end', () => {
    const { container, root } = render(<SidebarNavMarker kind="labs" />);

    const glyph = marker(container, 'sidebar-entry-marker-labs');
    expect(glyph.className).toContain('fg-quaternary');
    expect(glyph.className).toContain('h-4 w-4');
    expect(glyph.parentElement?.className).toContain('ml-auto');
    act(() => root.unmount());
  });

  // QA: the earlier `<>` code glyph read as a rotated dropdown chevron.
  it.each([
    ['dev', WrenchIcon],
    ['labs', ExperimentIcon],
  ] as const)('draws the %s marker with its own glyph', (kind, Icon) => {
    const markup = renderToStaticMarkup(<SidebarNavMarker kind={kind} />);
    const glyph = renderToStaticMarkup(<Icon size={16} />);
    expect(markup).toContain(glyph);
  });

  it('accepts a test id override', () => {
    expect(
      renderToStaticMarkup(
        <SidebarNavMarker kind="labs" data-testid="custom-marker" />,
      ),
    ).toContain('data-testid="custom-marker"');
  });

  it.each(['dev', 'labs'] as const)(
    'explains a %s page in a tooltip on hover',
    (kind) => {
      const { container, root } = render(<SidebarNavMarker kind={kind} />);

      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      act(() => {
        marker(container, `sidebar-entry-marker-${kind}`).dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
      });
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        SIDEBAR_NAV_MARKER_TOOLTIPS[kind],
      );
      act(() => root.unmount());
    },
  );

  it('uses the Labs and Dev tooltip copy', () => {
    expect(SIDEBAR_NAV_MARKER_TOOLTIPS).toEqual({
      dev: 'Dev only. Not shown in shipped builds.',
      labs: 'Labs experiment. Turn it off in Settings → Labs.',
    });
  });
});
