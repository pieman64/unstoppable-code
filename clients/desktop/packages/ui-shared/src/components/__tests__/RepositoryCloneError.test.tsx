/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { RepositoryCloneError } from '../RepositoryCloneError';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

it('renders one destructive alert with attribution, selectors and literal text', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <RepositoryCloneError
          id="clone-error"
          testId="clone-error-test"
          prefix="Remote Control"
          message={'Failed <script>alert("secret")</script>'}
        />,
      ),
    );
    const alert = container.querySelector('[role="alert"]');
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(alert?.id).toBe('clone-error');
    expect(alert?.getAttribute('data-testid')).toBe('clone-error-test');
    expect(alert?.getAttribute('data-notice-intent')).toBe('destructive');
    expect(alert?.textContent).toBe(
      'Remote Control: Failed <script>alert("secret")</script>',
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
