/** @jest-environment jsdom */
import {
  MERMAID_EXPORT_MAX_SIDE,
  MERMAID_EXPORT_TOO_LARGE,
  MermaidExportError,
  mermaidClipboardHtml,
  mermaidRasterScale,
  rasterizeMermaidSvg,
  standaloneMermaidSvg,
  svgDataUrl,
} from '../markdown-mermaid-export';
import {
  MARKDOWN_ROOT_ATTRIBUTE,
  mermaidAccessibleName,
  mermaidDiagramContext,
  mermaidExportFilenames,
  mermaidExportStem,
  mermaidFamilyLabel,
} from '../markdown-mermaid-export-names';

jest.mock('mermaid', () => ({ initialize: jest.fn(), render: jest.fn() }));
// jsdom omits the encoder every browser provides.
class Utf8Encoder {
  encode(text: string): Uint8Array {
    return Uint8Array.from(Buffer.from(text, 'utf8'));
  }
}
if (typeof globalThis.TextEncoder === 'undefined') {
  Reflect.set(globalThis, 'TextEncoder', Utf8Encoder);
}

function parse(svg: string): Element {
  return new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
}

describe('standalone diagram SVG', () => {
  it('keeps the viewBox, sizes the document and paints the surface behind it', () => {
    const result = standaloneMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 320 140" style="max-width: 320px" aria-hidden="true"><text>Ship</text></svg>',
      'rgb(20, 20, 20)',
    );
    expect(result).toMatchObject({ width: 320, height: 140 });
    const root = parse(result.svg);
    expect(root.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
    expect(root.getAttribute('viewBox')).toBe('-8 -8 320 140');
    expect(root.getAttribute('width')).toBe('320');
    expect(root.getAttribute('height')).toBe('140');
    expect(root.hasAttribute('style')).toBe(false);
    expect(root.hasAttribute('aria-hidden')).toBe(false);
    const backdrop = root.firstElementChild;
    expect(backdrop?.localName).toBe('rect');
    expect(backdrop?.getAttribute('x')).toBe('-8');
    expect(backdrop?.getAttribute('fill')).toBe('rgb(20, 20, 20)');
    expect(root.textContent).toContain('Ship');
  });

  it('ends every font list in system fonts so text never falls back to serif', () => {
    const result = standaloneMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>#d{font-family:Inter;fill:#000}#d .x{font-family:Inter,sans-serif}</style><text style="font-size: 16px; font-family: Inter;">A</text></svg>',
      '#fff',
    );
    const root = parse(result.svg);
    expect(root.querySelector('style')?.textContent).toBe(
      '#d{font-family:Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;fill:#000}#d .x{font-family:Inter,sans-serif}',
    );
    expect(root.querySelector('text')?.getAttribute('style')).toBe(
      'font-size: 16px; font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;',
    );
    expect(root.getAttribute('font-family')).toMatch(/sans-serif$/);
  });

  it('falls back to pixel dimensions and rejects unusable sizes', () => {
    const fallback = standaloneMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="90px" height="40"><text>A</text></svg>',
      '#fff',
    );
    expect(fallback).toMatchObject({ width: 90, height: 40 });
    expect(parse(fallback.svg).getAttribute('viewBox')).toBe('0 0 90 40');
    expect(() =>
      standaloneMermaidSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 10" width="50%"></svg>',
        '#fff',
      ),
    ).toThrow(MermaidExportError);
  });

  it('preserves the authored aspect-ratio policy', () => {
    const diagram = standaloneMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10" preserveAspectRatio="xMinYMin slice"/>',
      '#fff',
    );
    expect(parse(diagram.svg).getAttribute('preserveAspectRatio')).toBe(
      'xMinYMin slice',
    );
  });

  it('applies the renderer sanitizer before anything leaves the app', () => {
    const result = standaloneMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)"><text>Label</text></a><image href="https://tracker.invalid"/></svg>',
      '#fff',
    );
    expect(result.svg).not.toMatch(/script|onload|javascript:|<image|https:/);
    const html = mermaidClipboardHtml(result, 'Flow "diagram" <A>');
    expect(html).toContain(`src="${svgDataUrl(result.svg)}"`);
    expect(html).toContain('alt="Flow &quot;diagram&quot; &lt;A&gt;"');
    expect(html).not.toContain('blob:');
  });
});

describe('PNG scale limits', () => {
  it('uses the device scale within the side and pixel budgets', () => {
    expect(mermaidRasterScale(400, 200, 2)).toBe(2);
    expect(mermaidRasterScale(400, 200, 8)).toBe(3);
    expect(mermaidRasterScale(4000, 100, 2)).toBeCloseTo(
      MERMAID_EXPORT_MAX_SIDE / 4000,
    );
    const square = mermaidRasterScale(4096, 4096, 2);
    expect(4096 * square * 4096 * square).toBeLessThanOrEqual(16_777_216);
  });

  it('refuses diagrams above the longest-side limit', () => {
    expect(() => mermaidRasterScale(4097, 10, 1)).toThrow(
      MERMAID_EXPORT_TOO_LARGE,
    );
    expect(() => mermaidRasterScale(Number.NaN, 10, 1)).toThrow(
      MermaidExportError,
    );
  });
});

describe('diagram names', () => {
  it.each([
    ['flowchart LR\nA-->B', 'Flow diagram'],
    ['graph TD\nA-->B', 'Flow diagram'],
    ['%% note\nsequenceDiagram\nA->>B: hi', 'Sequence diagram'],
    ['%%{init: {}}%%\nclassDiagram\nA <|-- B', 'Class diagram'],
    ['stateDiagram-v2\n[*] --> A', 'State diagram'],
    [
      '---\ntitle: Data\n---\nerDiagram\nA ||--o{ B : has',
      'Entity relationship diagram',
    ],
    ['gantt\ntitle Plan', 'Gantt chart'],
    ['pie\n"A": 1', 'Diagram'],
  ])('labels %j as %s', (source, label) => {
    expect(mermaidFamilyLabel(source)).toBe(label);
  });

  it('prefers an authored title over the derived name', () => {
    expect(mermaidAccessibleName('Release', 'Flow diagram', 'Plan')).toBe(
      'Release',
    );
    expect(mermaidAccessibleName(undefined, 'Flow diagram', 'Plan')).toBe(
      'Flow diagram: Plan',
    );
    expect(mermaidAccessibleName(undefined, 'Gantt chart', null)).toBe(
      'Gantt chart',
    );
  });

  it('builds bounded, cross-platform file names', () => {
    expect(
      mermaidExportStem({
        documentName: 'docs/Plan.v2.md',
        heading: 'Café — Rollout / Phase 1',
        index: 3,
      }),
    ).toBe('Plan.v2-café-rollout-phase-1');
    expect(
      mermaidExportStem({ documentName: 'notes.md', heading: '***', index: 2 }),
    ).toBe('notes-diagram-2');
    expect(mermaidExportStem({ heading: null, index: 1 })).toBe('diagram-1');
    expect(mermaidExportStem({ heading: 'con', index: 1 })).toBe('con-diagram');
    expect(
      mermaidExportStem({
        documentName: 'a<b>:c. .md',
        heading: null,
        index: 1,
      }),
    ).toBe('a-b-c-diagram-1');
    expect(
      mermaidExportStem({ heading: 'x'.repeat(200), index: 1 }).length,
    ).toBeLessThanOrEqual(60);
    const names = mermaidExportFilenames('plan', 'png');
    expect(names).toHaveLength(20);
    expect(names.slice(0, 2)).toEqual(['plan.png', 'plan-2.png']);
    expect(names[19]).toBe('plan-20.png');
  });

  it('bounds Unicode names in filesystem bytes and escapes dotted Windows device names', () => {
    const stem = mermaidExportStem({
      documentName: '漢'.repeat(80) + '.md',
      heading: '字'.repeat(60),
      index: 1,
    });
    expect(
      Buffer.byteLength(mermaidExportFilenames(stem, 'svg')[19] ?? '', 'utf8'),
    ).toBeLessThanOrEqual(255);
    expect(
      mermaidExportStem({
        documentName: 'CON.txt.md',
        heading: 'Release',
        index: 1,
      }),
    ).not.toMatch(/^con\./i);
  });

  it('skips multiline init directives when identifying the family', () => {
    expect(
      mermaidFamilyLabel(
        '%%{init: {\n  "theme": "dark"\n}}%%\nsequenceDiagram\nA->>B: hi',
      ),
    ).toBe('Sequence diagram');
  });

  it('reads headings and numbering only within the diagram’s own root', () => {
    document.body.innerHTML = `
      <div ${MARKDOWN_ROOT_ATTRIBUTE}><h1>Elsewhere</h1></div>
      <div ${MARKDOWN_ROOT_ATTRIBUTE} id="root">
        <figure data-testid="markdown-mermaid" id="first"></figure>
        <h2>Deploy</h2>
        <figure data-testid="markdown-mermaid" id="second"></figure>
      </div>
      <figure data-testid="markdown-mermaid" id="loose"></figure>`;
    const at = (id: string): Element =>
      document.getElementById(id) ?? document.body;
    expect(mermaidDiagramContext(at('first'))).toEqual({
      heading: null,
      index: 1,
    });
    expect(mermaidDiagramContext(at('second'))).toEqual({
      heading: 'Deploy',
      index: 2,
    });
    expect(mermaidDiagramContext(at('loose'))).toEqual({
      heading: null,
      index: 1,
    });
  });
});

describe('raster conversion failures and cleanup', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each(['success', 'decode', 'canvas', 'security', 'null-blob'])(
    'releases image and canvas resources after %s',
    async (outcome) => {
      const image = document.createElement('img');
      const decode =
        outcome === 'decode'
          ? jest.fn().mockRejectedValue(new Error('decode failed'))
          : jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(image, 'decode', { value: decode });
      jest.spyOn(window, 'Image').mockImplementation(() => image);
      const drawImage = jest.fn();
      if (outcome === 'canvas')
        drawImage.mockImplementation(() => {
          throw new DOMException('Tainted', 'SecurityError');
        });
      jest
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
      const canvases: HTMLCanvasElement[] = [];
      const create = document.createElement.bind(document);
      jest
        .spyOn(document, 'createElement')
        .mockImplementation((name, options) => {
          const element = create(name, options);
          if (element instanceof HTMLCanvasElement) canvases.push(element);
          return element;
        });
      jest
        .spyOn(HTMLCanvasElement.prototype, 'toBlob')
        .mockImplementation(function (callback) {
          if (outcome === 'security')
            throw new DOMException('Tainted', 'SecurityError');
          callback(
            outcome === 'null-blob'
              ? null
              : new Blob(['png'], { type: 'image/png' }),
          );
        });
      const result = rasterizeMermaidSvg(
        { svg: '<svg/>', width: 200, height: 100 },
        document,
      );
      if (outcome === 'success')
        await expect(result).resolves.toMatchObject({
          type: 'image/png',
          size: 3,
        });
      else await expect(result).rejects.toBeInstanceOf(Error);
      expect(image.hasAttribute('src')).toBe(false);
      expect(canvases).toHaveLength(1);
      expect(canvases[0]?.width).toBe(0);
      expect(canvases[0]?.height).toBe(0);
    },
  );
  it('turns a serialization failure into an export failure', () => {
    jest
      .spyOn(XMLSerializer.prototype, 'serializeToString')
      .mockImplementation(() => {
        throw new Error('serialize failed');
      });
    expect(() =>
      standaloneMermaidSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>',
        '#fff',
      ),
    ).toThrow(MermaidExportError);
  });
});
