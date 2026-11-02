import {
  codeFenceMarkdown,
  latexOutputMarkdown,
  selectNotebookOutputRendering,
  svgImageDataUrl,
} from '../notebook-mime';
import type { NotebookMimeBundle } from '../notebook-types';

describe('notebook MIME helpers', () => {
  it.each([
    [
      'PNG before every other supported type',
      {
        'image/png': 'AAAA',
        'image/jpeg': 'BBBB',
        'image/svg+xml': '<svg />',
        'text/latex': 'x^2',
        'text/markdown': '**markdown**',
        'text/plain': 'plain',
      },
      'image',
    ],
    [
      'JPEG before SVG and text',
      {
        'image/jpeg': 'AAAA',
        'image/svg+xml': '<svg />',
        'text/latex': 'x^2',
        'text/markdown': '**markdown**',
        'text/plain': 'plain',
      },
      'image',
    ],
    [
      'SVG before text',
      {
        'image/svg+xml': '<svg />',
        'text/latex': 'x^2',
        'text/markdown': '**markdown**',
        'text/plain': 'plain',
      },
      'image',
    ],
    [
      'LaTeX before Markdown and plain text',
      {
        'text/latex': 'x^2',
        'text/markdown': '**markdown**',
        'text/plain': 'plain',
      },
      'latex',
    ],
    [
      'Markdown before plain text',
      { 'text/markdown': '**markdown**', 'text/plain': 'plain' },
      'markdown',
    ],
  ])('uses the expected priority for %s', (_description, data, kind) => {
    const rendering = selectNotebookOutputRendering(data);
    expect(rendering?.kind).toBe(kind);
  });

  it('skips invalid base64 PNG data and falls back to plain text', () => {
    const rendering = selectNotebookOutputRendering({
      'image/png': 'not base64!',
      'text/plain': 'fallback text',
    });

    expect(rendering).toEqual({ kind: 'text', text: 'fallback text' });
  });

  it('removes whitespace from valid base64 image data', () => {
    const rendering = selectNotebookOutputRendering({
      'image/png': ' AA\nAA\t ',
    });

    expect(rendering).toEqual({
      kind: 'image',
      mime: 'image/png',
      src: 'data:image/png;base64,AAAA',
    });
  });

  it('encodes SVG as a UTF-8 base64 image data URL', () => {
    const svg = '<svg><text>café 東京</text></svg>';
    const dataUrl = svgImageDataUrl(svg);
    const base64 = dataUrl?.split(',')[1];
    const binary = base64 ? atob(base64) : '';
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );

    expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(new TextDecoder().decode(bytes)).toBe(svg);
  });

  it('ignores HTML and JavaScript MIME values', () => {
    const data: NotebookMimeBundle = {
      'text/html': '<strong>unsafe</strong>',
      'application/javascript': 'alert(1)',
      'text/plain': 'safe text',
    };

    expect(selectNotebookOutputRendering(data)).toEqual({
      kind: 'text',
      text: 'safe text',
    });
    expect(
      selectNotebookOutputRendering({
        'text/html': '<strong>unsafe</strong>',
      }),
    ).toBeNull();
    expect(
      selectNotebookOutputRendering({
        'application/javascript': 'alert(1)',
      }),
    ).toBeNull();
  });

  it('uses source-safe fences and suppresses special language hints', () => {
    expect(codeFenceMarkdown('contains ``` ticks', 'typescript')).toBe(
      '````typescript\ncontains ``` ticks\n````',
    );
    expect(codeFenceMarkdown('x^2', 'LaTeX')).toBe('```\nx^2\n```');
    expect(codeFenceMarkdown('graph TD', 'mermaid')).toBe('```\ngraph TD\n```');
  });

  it('strips one math delimiter pair before fencing LaTeX', () => {
    expect(latexOutputMarkdown('  $$x^2$$  ')).toBe('```math\nx^2\n```');
    expect(latexOutputMarkdown('$x + y$')).toBe('```math\nx + y\n```');
    expect(latexOutputMarkdown(String.raw`\[x + y\]`)).toBe(
      '```math\nx + y\n```',
    );
    expect(latexOutputMarkdown('  ')).toBe('');
  });
});
