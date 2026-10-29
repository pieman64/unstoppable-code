/**
 * @jest-environment jsdom
 */
import {
  createHighlightContributor,
  type HighlightContributor,
} from '@/lib/css-highlights';

/** Minimal stand-in for the Custom Highlight API, which jsdom lacks. */
class FakeHighlight {
  readonly ranges: readonly Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

function installFakeHighlights(view: Window): Map<string, FakeHighlight> {
  const registry = new Map<string, FakeHighlight>();
  Object.defineProperty(view, 'CSS', {
    configurable: true,
    value: { highlights: registry },
  });
  Object.defineProperty(view, 'Highlight', {
    configurable: true,
    value: FakeHighlight,
  });
  return registry;
}

function rangeOver(doc: Document, text: string): Range {
  const node = doc.createTextNode(text);
  doc.body.appendChild(node);
  const range = doc.createRange();
  range.selectNodeContents(node);
  return range;
}

/** Compare by identity: jsdom `Range` wrappers do not deep-compare. */
function expectRanges(
  registry: Map<string, FakeHighlight>,
  name: string,
  expected: readonly Range[],
): void {
  const actual = registry.get(name)?.ranges ?? [];
  expect(actual).toHaveLength(expected.length);
  expected.forEach((range, index) => {
    expect(actual[index]).toBe(range);
  });
}

describe('createHighlightContributor', () => {
  let mainRegistry: Map<string, FakeHighlight>;
  let created: HighlightContributor[] = [];

  // Views dispose their contributor on unmount; tests do the same so no
  // ranges leak into the next case through the per-window registry.
  function contributorFor(doc: Document): HighlightContributor {
    const contributor = createHighlightContributor(doc);
    created.push(contributor);
    return contributor;
  }

  beforeEach(() => {
    mainRegistry = installFakeHighlights(window);
    document.body.innerHTML = '';
  });

  afterEach(() => {
    for (const contributor of created) {
      contributor.dispose();
    }
    created = [];
    Reflect.deleteProperty(window, 'CSS');
    Reflect.deleteProperty(window, 'Highlight');
  });

  it('registers a named highlight in the main window', () => {
    const contributor = contributorFor(document);
    const range = rangeOver(document, 'anchor');

    contributor.set('plan-comment-anchor', [range]);

    expectRanges(mainRegistry, 'plan-comment-anchor', [range]);
  });

  it('unions ranges from contributors sharing a window and name', () => {
    const first = contributorFor(document);
    const second = contributorFor(document);
    const a = rangeOver(document, 'first');
    const b = rangeOver(document, 'second');

    first.set('plan-comment-anchor', [a]);
    second.set('plan-comment-anchor', [b]);

    expectRanges(mainRegistry, 'plan-comment-anchor', [a, b]);

    // Replacing one contributor's ranges leaves the other's intact.
    first.set('plan-comment-anchor', []);
    expectRanges(mainRegistry, 'plan-comment-anchor', [b]);
  });

  it("keeps another view's ranges when one contributor is disposed", () => {
    const first = contributorFor(document);
    const second = contributorFor(document);
    const a = rangeOver(document, 'first');
    const b = rangeOver(document, 'second');
    const draft = rangeOver(document, 'draft');
    first.set('plan-comment-anchor', [a]);
    first.set('plan-comment-draft', [draft]);
    second.set('plan-comment-anchor', [b]);

    first.dispose();

    expectRanges(mainRegistry, 'plan-comment-anchor', [b]);
    expect(mainRegistry.has('plan-comment-draft')).toBe(false);

    second.clear('plan-comment-anchor');
    expect(mainRegistry.has('plan-comment-anchor')).toBe(false);
  });

  it("paints into the owner document's window, not the main window", () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const frameDocument = frame.contentDocument;
    const frameWindow = frame.contentWindow;
    if (!frameDocument || !frameWindow) {
      throw new Error('Expected an iframe document');
    }
    const frameRegistry = installFakeHighlights(frameWindow);
    const mainContributor = contributorFor(document);
    const frameContributor = contributorFor(frameDocument);
    const mainRange = rangeOver(document, 'main');
    const frameRange = rangeOver(frameDocument, 'aux');

    mainContributor.set('plan-comment-anchor', [mainRange]);
    frameContributor.set('plan-comment-anchor', [frameRange]);

    expectRanges(mainRegistry, 'plan-comment-anchor', [mainRange]);
    expectRanges(frameRegistry, 'plan-comment-anchor', [frameRange]);

    frameContributor.dispose();
    expect(frameRegistry.has('plan-comment-anchor')).toBe(false);
    expectRanges(mainRegistry, 'plan-comment-anchor', [mainRange]);
  });

  it('is a no-op when the window lacks the Custom Highlight API', () => {
    Reflect.deleteProperty(window, 'CSS');
    Reflect.deleteProperty(window, 'Highlight');
    const contributor = contributorFor(document);

    expect(() => {
      contributor.set('plan-comment-anchor', [rangeOver(document, 'x')]);
      contributor.dispose();
    }).not.toThrow();
  });
});
