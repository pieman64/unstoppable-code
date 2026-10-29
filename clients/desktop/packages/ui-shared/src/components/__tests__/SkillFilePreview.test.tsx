/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SkillFilePreview } from '../SkillFilePreview';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function mount(element: JSX.Element): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

describe('SkillFilePreview', () => {
  it('renders markdown content and its truncation state with stable metadata', () => {
    const { container, root } = mount(
      <SkillFilePreview
        filePath="references/notes.md"
        state={{
          loading: false,
          error: '',
          data: { content: '# Notes', truncated: true, binary: false },
        }}
      />,
    );

    const preview = container.querySelector(
      '[data-testid="skill-file-preview"]',
    );
    expect(preview?.getAttribute('data-path')).toBe('references/notes.md');
    expect(preview?.querySelector('h1')?.textContent).toBe('Notes');
    expect(container.textContent).toContain('only the beginning is shown');
    act(() => root.unmount());
  });

  it('renders loading, error, and binary states', () => {
    const { container, root } = mount(
      <SkillFilePreview
        filePath="asset.bin"
        state={{ loading: true, error: '', data: null }}
      />,
    );
    expect(container.textContent).toContain('Loading');

    act(() =>
      root.render(
        <SkillFilePreview
          filePath="asset.bin"
          state={{ loading: false, error: 'Read failed.', data: null }}
        />,
      ),
    );
    expect(container.textContent).toContain('Read failed.');

    act(() =>
      root.render(
        <SkillFilePreview
          filePath="asset.bin"
          state={{
            loading: false,
            error: '',
            data: { content: '', truncated: false, binary: true },
          }}
        />,
      ),
    );
    expect(container.textContent).toContain('binary and cannot be previewed');
    act(() => root.unmount());
  });
});
