/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemberAvatar } from '../MemberAvatar';

describe('MemberAvatar image failure handling', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('falls back to the initials placeholder when the image fails to load', () => {
    act(() => {
      root.render(
        <MemberAvatar
          name="Grace Hopper"
          image="https://storage.googleapis.com/bucket/avatar.png"
        />,
      );
    });

    const img = container.querySelector('img');
    if (!img) throw new Error('Expected an <img> before the load error');

    act(() => {
      img.dispatchEvent(new Event('error', { bubbles: true }));
    });

    expect(container.querySelector('img')).toBeNull();
    const placeholder = container.querySelector('[role="img"]');
    expect(placeholder?.getAttribute('aria-label')).toBe('Grace Hopper');
    expect(placeholder?.textContent).toBe('GH');
  });
});
