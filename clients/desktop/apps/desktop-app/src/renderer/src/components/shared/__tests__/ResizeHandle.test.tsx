import { renderToStaticMarkup } from 'react-dom/server';
import { ResizeHandle } from '../ResizeHandle';

function handleClasses(markup: string): string[] {
  const match = markup.match(/<div[^>]*class="([^"]*)"[^>]*role="separator"/);
  return (match?.[1] ?? '').split(/\s+/).filter(Boolean);
}

describe('ResizeHandle', () => {
  it('owns the axis geometry and cursor of each orientation', () => {
    const vertical = handleClasses(
      renderToStaticMarkup(
        <ResizeHandle orientation="vertical" onDrag={jest.fn()} />,
      ),
    );
    expect(vertical).toEqual(
      expect.arrayContaining(['h-2', 'w-full', 'cursor-row-resize']),
    );
    expect(vertical).not.toContain('border-t');
    expect(vertical).not.toContain('border-l');

    const horizontal = handleClasses(
      renderToStaticMarkup(
        <ResizeHandle orientation="horizontal" onDrag={jest.fn()} />,
      ),
    );
    expect(horizontal).toEqual(
      expect.arrayContaining(['h-full', 'w-2', 'cursor-col-resize']),
    );
  });

  it('draws the hairline along its leading edge when it doubles as the pane edge', () => {
    const vertical = handleClasses(
      renderToStaticMarkup(
        <ResizeHandle orientation="vertical" onDrag={jest.fn()} divider />,
      ),
    );
    expect(vertical).toEqual(expect.arrayContaining(['border-t']));
    expect(vertical).not.toContain('border-l');

    const horizontal = handleClasses(
      renderToStaticMarkup(
        <ResizeHandle orientation="horizontal" onDrag={jest.fn()} divider />,
      ),
    );
    expect(horizontal).toEqual(expect.arrayContaining(['border-l']));
    expect(horizontal).not.toContain('border-t');
  });

  it('keeps placement classes on the handle', () => {
    const classes = handleClasses(
      renderToStaticMarkup(
        <ResizeHandle
          orientation="horizontal"
          onDrag={jest.fn()}
          className="-right-1"
        />,
      ),
    );

    expect(classes).toContain('-right-1');
  });
});
