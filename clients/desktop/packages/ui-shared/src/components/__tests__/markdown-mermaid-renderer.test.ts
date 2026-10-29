/** @jest-environment jsdom */
import { sanitizeMermaidSvg } from '../markdown-mermaid-renderer';
jest.mock('mermaid', () => ({ initialize: jest.fn(), render: jest.fn() }));

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
