/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarSection } from '../SidebarSection';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('SidebarSection content inset', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function contentClasses(): string[] {
    return (
      container.querySelector('[data-sidebar-section-content]')?.className ?? ''
    ).split(/\s+/);
  }

  it('renders the disclosure content flush by default', () => {
    act(() => {
      root.render(<SidebarSection title="Hidden">Rows</SidebarSection>);
    });

    const tokens = contentClasses();
    expect(tokens).toContain('sidebar-fade-presence');
    expect(tokens).not.toContain('pb-1');
  });

  it('insets the bottom of the disclosure content by the sidebar unit', () => {
    act(() => {
      root.render(
        <SidebarSection title="Hidden" spacing="inset">
          Rows
        </SidebarSection>,
      );
    });

    const tokens = contentClasses();
    expect(tokens).toContain('sidebar-fade-presence');
    expect(tokens).toContain('pb-1');
  });

  it('insets a non-collapsible section the same way', () => {
    act(() => {
      root.render(
        <SidebarSection title="Hidden" spacing="inset" collapsible={false}>
          Rows
        </SidebarSection>,
      );
    });

    expect(contentClasses()).toContain('pb-1');
  });
});
