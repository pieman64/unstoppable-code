/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineMention } from '../InlineMention';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Glyph({ className }: { className?: string }): JSX.Element {
  return <svg data-testid="glyph" className={className} />;
}

describe('InlineMention', () => {
  it('renders a non-interactive neutral span chip sized to the text', () => {
    const html = renderToStaticMarkup(
      <InlineMention icon={Glyph} title="Plugin: figma" data-testid="pill">
        figma
      </InlineMention>,
    );
    expect(html).toMatch(/^<span /);
    expect(html).not.toContain('<button');
    expect(html).toContain('data-testid="pill"');
    expect(html).toContain('title="Plugin: figma"');
    // Something that does not open stays out of the accent ink.
    expect(html).toContain('bg-muted');
    expect(html).not.toContain('fg-accent');
    // The chip and its glyph are measured in em so they follow the font.
    expect(html).toContain('text-[0.857em]');
    expect(html).toContain('align-[0.0625em]');
    expect(html).toContain('h-[1em] w-[1em]');
    expect(html).toContain('align-[-0.133em]');
    expect(html).not.toContain('cursor-pointer');
  });

  it('renders an accent button chip when it opens something', () => {
    const html = renderToStaticMarkup(
      <InlineMention
        icon={Glyph}
        aria-label="Open src/app.ts"
        onClick={() => {}}
      >
        src/app.ts
      </InlineMention>,
    );
    expect(html).toMatch(/^<button type="button"/);
    expect(html).toContain('aria-label="Open src/app.ts"');
    expect(html).toContain('bg-accent-subtle');
    expect(html).toContain('fg-accent');
    expect(html).toContain('hover:bg-accent-subtle/80');
    expect(html).toContain('focus-ring');
  });

  it('calls onClick with the button event', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const onClick = jest.fn();
    act(() => {
      root.render(
        <InlineMention icon={Glyph} onClick={onClick}>
          docs/report.md
        </InlineMention>,
      );
    });
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    container.remove();
  });
});
