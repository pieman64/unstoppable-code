/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SearchBar } from '../SearchBar';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('SearchBar', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('defaults the placeholder and accepts a custom one', () => {
    const render = (placeholder?: string): void => {
      act((): void => {
        root.render(
          <SearchBar
            query=""
            onQueryChange={() => {}}
            currentIndex={0}
            totalCount={0}
            onNext={() => {}}
            onPrevious={() => {}}
            placeholder={placeholder}
          />,
        );
      });
    };

    render();
    expect(host.querySelector('input')?.placeholder).toBe('Search…');
    render('Search the file.');
    expect(host.querySelector('input')?.placeholder).toBe('Search the file.');
  });
});
