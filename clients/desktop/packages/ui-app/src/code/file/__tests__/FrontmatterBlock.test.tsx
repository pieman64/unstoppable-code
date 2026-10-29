/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
  writable: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FrontmatterBlock } from '../FrontmatterBlock';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('FrontmatterBlock', () => {
  it('renders nothing when there are no visible entries', () => {
    act(() => {
      root.render(
        <FrontmatterBlock frontmatter={{ a: '', b: null, c: undefined }} />,
      );
    });
    expect(container.querySelector('dl')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('renders formatted key-value pairs and drops empty values', () => {
    act(() => {
      root.render(
        <FrontmatterBlock
          frontmatter={{
            title: 'My Doc',
            draft: true,
            empty: '',
            tags: ['a', 'b'],
          }}
        />,
      );
    });

    const terms = Array.from(container.querySelectorAll('dt')).map(
      (element) => element.textContent,
    );
    const definitions = Array.from(container.querySelectorAll('dd')).map(
      (element) => element.textContent,
    );

    expect(terms).toEqual(['Title:', 'Draft:', 'Tags:']);
    expect(definitions).toEqual(['My Doc', 'Yes', '["a","b"]']);
  });

  it('appends a provided className to the outer card', () => {
    act(() => {
      root.render(
        <FrontmatterBlock frontmatter={{ title: 'x' }} className="mb-4" />,
      );
    });
    const card = container.firstElementChild;
    expect(card?.className).toContain('mb-4');
    expect(card?.className).toContain('rounded-lg');
  });
});
