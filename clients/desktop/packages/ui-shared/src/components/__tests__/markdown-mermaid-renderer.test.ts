/** @jest-environment jsdom */
import mermaid from 'mermaid';
import {
  renderMermaid,
  sanitizeMermaidSvg,
} from '../markdown-mermaid-renderer';
import { JOURNEY_BRIEF_DIAGRAM } from './fixtures/mermaid-diagrams';
jest.mock('mermaid', () => ({ initialize: jest.fn(), render: jest.fn() }));
const mockMermaidRender = jest.mocked(mermaid.render);

describe('Generated Mermaid SVG boundary', () => {
  it('preserves diagram labels and local marker references', () => {
    const clean = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><marker id="arrow"><path d="M0 0L1 1"/></marker></defs><path marker-end="url(#arrow)"/><text>Review &amp; save</text></svg>',
    );
    expect(clean).toContain('marker-end="url(#arrow)"');
    expect(clean).toContain('Review &amp; save');
  });
  it('removes scripts, foreign HTML, remote images, animation, handlers, navigation, and external CSS', () => {
    const clean = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" style="fill:url(https://tracker.invalid)"><script>alert(1)</script><foreignObject><div>HTML</div></foreignObject><image href="https://tracker.invalid"/><a href="javascript:alert(1)"><text>Label</text></a><animate attributeName="href" values="https://tracker.invalid"/><style>@import "https://tracker.invalid";</style><path style="fill:url(https://tracker.invalid)"/><use href="https://tracker.invalid"/></svg>',
    );
    expect(clean).not.toMatch(
      /script|foreignObject|<image|<animate|onload|javascript:|https:\/\//,
    );
  });
  it('removes escape-encoded external resources from every SVG attribute', () => {
    const clean = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="u\\72l(https://tracker.invalid/pixel)"/><path marker-end="u\\000072l(https://tracker.invalid/marker)"/><path fill="url(#safe-local-paint)"/></svg>',
    );
    expect(clean).not.toContain('tracker.invalid');
    expect(clean).not.toContain('u\\72l');
    expect(clean).toContain('fill="url(#safe-local-paint)"');
  });
  it('removes CSS image functions that can load string URLs', () => {
    const clean = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.x{mask-image:image-set("https://tracker.invalid/pixel")}</style><rect style="background-image:-webkit-image-set(\'https://tracker.invalid/other\')"/><path fill="cross-fade(https://tracker.invalid/a, red)"/></svg>',
    );
    expect(clean).not.toContain('tracker.invalid');
    expect(clean).not.toMatch(/image-set|cross-fade/);
  });
  it('bounds output and rejects malformed/non-SVG documents', () => {
    expect(() => sanitizeMermaidSvg('x'.repeat(1_000_001))).toThrow();
    expect(() => sanitizeMermaidSvg('<div>Not a diagram</div>')).toThrow();
  });
});

describe('Mermaid render input', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>Diagram</text></svg>';
  const getContext = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    'getContext',
  );
  beforeEach(() => {
    mockMermaidRender.mockReset().mockResolvedValue({
      svg,
      diagramType: 'flowchart-v2',
    });
    // jsdom has no canvas; theme colours only need a readable pixel.
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: (): Pick<CanvasRenderingContext2D, 'fillRect'> & {
        getImageData: () => { data: Uint8ClampedArray };
      } => ({
        fillRect: jest.fn(),
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      }),
    });
  });
  afterEach(() => {
    if (getContext)
      Object.defineProperty(
        HTMLCanvasElement.prototype,
        'getContext',
        getContext,
      );
  });

  it('never passes refused input to Mermaid', async () => {
    const element = document.createElement('div');
    await expect(
      renderMermaid(
        'flowchart LR\nA-->B\nstyle A fill:#f00\nclick A "https://tracker.invalid"',
        element,
        () => true,
      ),
    ).rejects.toThrow("This diagram uses features that can't be drawn here.");
    await expect(
      renderMermaid(
        'flowchart LR\nA-->B\nstyle A fill:#f00; font-size:99px',
        element,
        () => true,
      ),
    ).rejects.toThrow();
    expect(mockMermaidRender).not.toHaveBeenCalled();
  });

  it('renders admitted diagrams from the prepared source', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    try {
      await renderMermaid(JOURNEY_BRIEF_DIAGRAM, element, () => true);
      await renderMermaid(
        'flowchart LR\nA-->B\nstyle A fill:#f00,font-size:20px',
        element,
        () => true,
      );
    } finally {
      element.remove();
    }
    expect(mockMermaidRender.mock.calls.map((call) => call[1])).toEqual([
      JOURNEY_BRIEF_DIAGRAM,
      'flowchart LR\nA-->B\nstyle A fill:#f00',
    ]);
  });
});

describe('Generated Mermaid styling', () => {
  it('keeps class rules, generated !important, and node style attributes', () => {
    const clean = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>#d1 .pain rect{fill:rgb(253, 226, 226)!important;stroke:rgb(217, 83, 79)!important;color:rgb(90, 26, 26)!important;}</style><g class="node pain"><rect style="fill:#fde2e2 !important;stroke:#d9534f !important"/></g><path style="stroke:#ff0000;stroke-width:4px;fill:none"/></svg>',
    );
    expect(clean).toContain('#d1 .pain rect{fill:rgb(253, 226, 226)!important');
    expect(clean).toContain(
      'style="fill:#fde2e2 !important;stroke:#d9534f !important"',
    );
    expect(clean).toContain('stroke:#ff0000;stroke-width:4px');
  });

  it('still removes resource-bearing styles from generated output', () => {
    const clean = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>#d1 .pain rect{fill:#fde2e2!important;}</style><style>.x{fill:url(https://tracker.invalid/a)}</style><rect style="fill:#fde2e2 !important;background:url(https://tracker.invalid/b)"/></svg>',
    );
    expect(clean).not.toContain('tracker.invalid');
    expect(clean).toContain('#d1 .pain rect{fill:#fde2e2!important;}');
  });
});
