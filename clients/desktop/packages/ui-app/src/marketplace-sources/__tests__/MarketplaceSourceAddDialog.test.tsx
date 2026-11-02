/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  MarketplaceSourceAddSession,
  MarketplaceSourcesClient,
} from '@canopy/app-core/client';
import { MarketplaceSourceAddDialog } from '../MarketplaceSourceAddDialog';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function session(
  mode: MarketplaceSourceAddSession['mode'],
  inputKind: MarketplaceSourceAddSession['inputKind'],
): MarketplaceSourceAddSession {
  return {
    mode,
    inputKind,
    getSnapshot: () => ({ phase: 'input' }),
    subscribe: () => () => undefined,
    validate: () => null,
    submit: () => Promise.resolve(),
    retryPreview: () => Promise.resolve(),
    retryReconciliation: () => Promise.resolve(),
    confirm: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
    dispose: () => undefined,
  };
}

function client(
  addSession: MarketplaceSourceAddSession,
): MarketplaceSourcesClient {
  const empty = { sources: [], lastRefreshedAt: '' };
  return {
    createAddSession: () => addSession,
    list: () => Promise.resolve(empty),
    refreshAll: () => Promise.resolve(empty),
    update: () => Promise.reject(new Error('unused')),
    remove: () => Promise.reject(new Error('unused')),
  };
}

describe('MarketplaceSourceAddDialog (CAN-4267)', () => {
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

  function render(addSession: MarketplaceSourceAddSession): HTMLElement {
    act(() =>
      root.render(
        <MarketplaceSourceAddDialog
          client={client(addSession)}
          onClose={() => undefined}
          onComplete={() => undefined}
        />,
      ),
    );
    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="marketplace-source-add-dialog"]',
    );
    if (!dialog) throw new Error('dialog did not render');
    return dialog;
  }

  it('tells the host when its session closes itself', () => {
    let snapshot: ReturnType<MarketplaceSourceAddSession['getSnapshot']> = {
      phase: 'input',
    };
    const listeners = new Set<() => void>();
    const closing: MarketplaceSourceAddSession = {
      ...session('direct', 'github'),
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const onClose = jest.fn();
    act(() =>
      root.render(
        <MarketplaceSourceAddDialog
          client={client(closing)}
          onClose={onClose}
          onComplete={() => undefined}
        />,
      ),
    );
    // The host invalidated the binding (an account or client change).
    act(() => {
      snapshot = { phase: 'closed' };
      listeners.forEach((listener) => listener());
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['direct', 'github', 'Repository', 'Add'],
    [
      'revision-review',
      'github-or-skills',
      'Repository or skills.sh URL',
      'Continue',
    ],
  ] as const)(
    'leads with the same sentence on every host; %s names its own field and action',
    (mode, inputKind, field, action) => {
      const dialog = render(session(mode, inputKind));
      expect(dialog.textContent).toContain(
        'Add a Claude or Codex marketplace.',
      );
      expect(dialog.querySelector('label span')?.textContent).toBe(field);
      const buttons = Array.from(dialog.querySelectorAll('button')).map(
        (button) => button.textContent,
      );
      expect(buttons).toContain(action);
    },
  );
});
