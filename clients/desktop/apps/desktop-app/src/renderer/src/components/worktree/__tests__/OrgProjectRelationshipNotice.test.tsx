/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OrgProjectRelationshipNotice } from '../OrgProjectRelationshipNotice';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('organization project relationship notice', () => {
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
  function render(dismiss: () => Promise<void>): void {
    act(() => {
      root.render(
        <OrgProjectRelationshipNotice
          actions={{ dismiss, view: (): Promise<void> => Promise.resolve() }}
          onSetupSeparately={(): void => {}}
        />,
      );
    });
  }
  function button(name: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll('button')).find(
      (element) => element.textContent === name,
    );
    if (!(found instanceof HTMLButtonElement))
      throw new Error(`No ${name} button`);
    return found;
  }

  it('does not announce the standing notice', (): void => {
    render((): Promise<void> => Promise.resolve());
    // The copy is always on screen beside the row; announcing it on every
    // render would talk over the member for a state they did not just enter.
    expect(
      container
        .querySelector('[data-testid="org-project-relationship-notice"]')
        ?.getAttribute('role'),
    ).not.toBe('alert');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('announces a failed action', async (): Promise<void> => {
    render((): Promise<void> => Promise.reject(new Error('nope')));
    await act(async (): Promise<void> => {
      button('Dismiss').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('Could not update repository relationship');
  });
});
