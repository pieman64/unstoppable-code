/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  LinkSharingConfirmDialog,
  linkSharingConfirmCopy,
  type LinkSharingConfirmVariant,
} from '..';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('LinkSharingConfirmDialog', () => {
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

  function query(testId: string): HTMLElement | null {
    return document.body.querySelector(`[data-testid="${testId}"]`);
  }

  it.each<[LinkSharingConfirmVariant, string, string]>([
    ['off', 'Turn off link?', 'Turn off link'],
    ['reset', 'Reset link?', 'Reset link'],
    ['narrow', 'Limit link to Acme?', 'Limit access'],
  ])('renders the %s variant', (variant, title, confirmLabel) => {
    const onConfirm = jest.fn();
    act(() =>
      root.render(
        <LinkSharingConfirmDialog
          variant={variant}
          organizationName="Acme"
          onCancel={jest.fn()}
          onConfirm={onConfirm}
          testIdPrefix="share"
        />,
      ),
    );
    expect(document.body.textContent).toContain(title);
    const action = query('share-link-confirm-action');
    expect(action?.textContent).toBe(confirmLabel);
    act(() => action?.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('never calls link sharing "public"', () => {
    for (const variant of ['off', 'reset', 'narrow'] as const) {
      const copy = linkSharingConfirmCopy(variant, 'Acme');
      expect(
        `${copy.title} ${copy.body} ${copy.confirmLabel}`.toLowerCase(),
      ).not.toContain('public');
    }
  });

  it('locks both actions while busy', () => {
    const onCancel = jest.fn();
    act(() =>
      root.render(
        <LinkSharingConfirmDialog
          variant="off"
          organizationName="Acme"
          onCancel={onCancel}
          onConfirm={jest.fn()}
          busy
          testIdPrefix="share"
        />,
      ),
    );
    const cancel = query('share-link-confirm-cancel');
    expect(cancel).toHaveProperty('disabled', true);
    expect(query('share-link-confirm-action')?.textContent).toBe(
      'Turning off…',
    );
  });
});
