/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Markdown } from '../Markdown';
import { DeferredMarkdownMath } from '../DeferredMarkdownMath';
import { ensureMathCopyListener } from '../markdown-math-copy';
import {
  PANEL_CONTENT_ADOPTED_EVENT,
  PANEL_CONTENT_HOST_ATTRIBUTE,
} from '../../panels/panel-content-adoption';

jest.mock('../markdown-math-copy', () => ({
  ...jest.requireActual<object>('../markdown-math-copy'),
  ensureMathCopyListener: jest.fn(),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('DeferredMarkdownMath', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    jest.restoreAllMocks();
  });

  function render(markdown: string): void {
    act(() => {
      root.render(<Markdown>{markdown}</Markdown>);
    });
  }

  it('renders the delimited source on the math container and keeps its class', () => {
    act(() => {
      root.render(
        <DeferredMarkdownMath
          expression={{ source: 'x + y', display: false }}
          source={String.raw`\(x + y\)`}
        />,
      );
    });

    const mathContainer = host.querySelector('.canopy-markdown-math-container');
    expect(mathContainer).not.toBeNull();
    expect(
      mathContainer?.classList.contains('canopy-markdown-math-container'),
    ).toBe(true);
    expect(mathContainer?.getAttribute('data-math-source')).toBe(
      String.raw`\(x + y\)`,
    );
  });

  it('installs the copy listener in the document a mounted panel moves to', () => {
    host.setAttribute(PANEL_CONTENT_HOST_ATTRIBUTE, 'panel-1');
    act(() => {
      root.render(
        <DeferredMarkdownMath
          expression={{ source: 'x', display: false }}
          source={String.raw`\(x\)`}
        />,
      );
    });
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const auxDocument = frame.contentDocument;
    if (!auxDocument) throw new Error('Expected an iframe document');
    try {
      auxDocument.body.append(host);
      host.dispatchEvent(
        new (auxDocument.defaultView?.Event ?? Event)(
          PANEL_CONTENT_ADOPTED_EVENT,
        ),
      );
      expect(ensureMathCopyListener).toHaveBeenCalledWith(auxDocument);
    } finally {
      document.body.append(host);
      frame.remove();
    }
  });

  it("installs the copy listener on each formula's owner document", () => {
    act(() => {
      root.render(
        <DeferredMarkdownMath
          expression={{ source: 'x', display: false }}
          source={String.raw`\(x\)`}
        />,
      );
    });

    const mathContainer = host.querySelector('.canopy-markdown-math-container');
    expect(mathContainer).not.toBeNull();
    if (!mathContainer) throw new Error('Expected a rendered math container');
    expect(ensureMathCopyListener).toHaveBeenCalledWith(
      mathContainer.ownerDocument,
    );

    const secondDocument = document.implementation.createHTMLDocument();
    const secondHost = secondDocument.createElement('div');
    secondDocument.body.append(secondHost);
    const secondRoot = createRoot(secondHost);
    try {
      act(() => {
        secondRoot.render(
          <DeferredMarkdownMath
            expression={{ source: 'y', display: false }}
            source={String.raw`\(y\)`}
          />,
        );
      });

      const secondMathContainer = secondHost.querySelector(
        '.canopy-markdown-math-container',
      );
      expect(secondMathContainer).not.toBeNull();
      expect(ensureMathCopyListener).toHaveBeenCalledWith(secondDocument);
    } finally {
      act(() => {
        secondRoot.unmount();
      });
      secondHost.remove();
    }
  });

  it('preserves the original inline delimiter source', () => {
    render(String.raw`\(R(3,3)\)`);

    const mathContainers = host.querySelectorAll(
      '.canopy-markdown-math-container',
    );
    expect(mathContainers).toHaveLength(1);
    expect(mathContainers[0]?.getAttribute('data-math-source')).toBe(
      String.raw`\(R(3,3)\)`,
    );
  });

  it('preserves the original double-dollar source', () => {
    render('$$x^2$$');

    const mathContainers = host.querySelectorAll(
      '.canopy-markdown-math-container',
    );
    expect(mathContainers).toHaveLength(1);
    expect(mathContainers[0]?.getAttribute('data-math-source')).toBe('$$x^2$$');
  });

  it('wraps a math fence body in display delimiters', () => {
    render('```math\nx^2\n```');

    const mathContainers = host.querySelectorAll(
      '.canopy-markdown-math-container',
    );
    expect(mathContainers).toHaveLength(1);
    expect(mathContainers[0]?.getAttribute('data-math-source')).toBe(
      '$$\nx^2\n$$',
    );
  });
});
