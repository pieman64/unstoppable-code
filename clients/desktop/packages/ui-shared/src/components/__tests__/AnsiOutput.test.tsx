/** @jest-environment jsdom */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { AnsiOutput } from '../AnsiOutput';

const renderedLineCacheWrites: boolean[] = [];
const renderedLineCacheProxies = new WeakMap<
  object,
  React.RefObject<unknown>
>();
let layoutEffectDepth = 0;

jest.mock('react', () => {
  const actual = jest.requireActual<typeof React>('react');
  return {
    ...actual,
    useRef: <T,>(initialValue: T): React.RefObject<T> => {
      const ref = actual.useRef(initialValue);
      if (!(initialValue instanceof Map)) {
        return ref;
      }

      let proxy = renderedLineCacheProxies.get(ref);
      if (!proxy) {
        proxy = {
          get current(): unknown {
            return ref.current;
          },
          set current(value: unknown) {
            renderedLineCacheWrites.push(layoutEffectDepth > 0);
            ref.current = value as T;
          },
        };
        renderedLineCacheProxies.set(ref, proxy);
      }
      return proxy as React.RefObject<T>;
    },
    useLayoutEffect: (
      effect: React.EffectCallback,
      dependencies?: React.DependencyList,
    ): void => {
      actual.useLayoutEffect(() => {
        layoutEffectDepth += 1;
        try {
          return effect();
        } finally {
          layoutEffectDepth -= 1;
        }
      }, dependencies);
    },
  };
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function selectText(element: Element, text: string): void {
  const textNode = Array.from(element.childNodes).find(
    (node) => node.textContent?.includes(text) === true,
  );
  if (!textNode?.textContent) {
    throw new Error(`Could not find text to select: ${text}`);
  }
  const start = textNode.textContent.indexOf(text);
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, start + text.length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe('AnsiOutput', () => {
  beforeEach(() => {
    renderedLineCacheWrites.length = 0;
    layoutEffectDepth = 0;
  });

  it('preserves a text selection when output rerenders or appends', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const selectedText = 'keep this selected';

    React.act(() => {
      root.render(
        <AnsiOutput lines={[`prefix ${selectedText} suffix`, 'second line']} />,
      );
    });
    const firstLine = container.firstElementChild?.firstElementChild;
    if (!firstLine) {
      throw new Error('Expected AnsiOutput to render its first line');
    }
    selectText(firstLine, selectedText);
    expect(window.getSelection()?.toString()).toBe(selectedText);

    React.act(() => {
      root.render(
        <AnsiOutput lines={[`prefix ${selectedText} suffix`, 'second line']} />,
      );
    });
    expect(container.firstElementChild?.firstElementChild).toBe(firstLine);
    expect(window.getSelection()?.toString()).toBe(selectedText);

    React.act(() => {
      root.render(
        <AnsiOutput
          lines={[
            `prefix ${selectedText} suffix`,
            'second line',
            'streamed line',
          ]}
        />,
      );
    });
    expect(container.firstElementChild?.firstElementChild).toBe(firstLine);
    expect(window.getSelection()?.toString()).toBe(selectedText);

    React.act(() => root.unmount());
    container.remove();
  });

  it('commits the rendered-line cache only from a layout effect', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    React.act(() => {
      root.render(<AnsiOutput lines={['rendered line']} />);
    });

    expect(renderedLineCacheWrites).toEqual([true]);

    React.act(() => root.unmount());
    container.remove();
  });
});
