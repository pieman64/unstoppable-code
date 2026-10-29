/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ViewerDataSharingScopeStatus,
  ViewerDataSharingStatus,
} from '@canopy/protocol';
import type { WebBrandRuntime } from '@canopy/protocol/brand';
import { WEB_BRANDS } from '@canopy/brand/web';
import {
  createDataSharingOptInDismissalStore,
  type DataSharingOptInDismissalStorage,
  type DataSharingOptInDismissalStore,
} from '../data-sharing-opt-in-dismissal';
import {
  createTestSettingsHost,
  TestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';
import {
  resolveWebDataSharingOptIn,
  WebDataSharingOptIn,
  type WebDataSharingOptInProps,
} from '../web-data-sharing-opt-in';
import type { ViewerDataSharingLoadState } from '../use-viewer-data-sharing';

const canopyBrand: WebBrandRuntime = ((): WebBrandRuntime => {
  const brand = WEB_BRANDS.find((entry) => entry.id === 'canopy');
  if (!brand) {
    throw new Error('WEB_BRANDS does not include the default canopy brand');
  }
  return brand;
})();

const brandHost = createTestSettingsHost({
  brand: {
    id: canopyBrand.id,
    displayName: canopyBrand.displayName,
    internalName: canopyBrand.internalName,
  },
}).host;

const ORG_ID = '7F1C2D3E-4B5A-4C6D-8E9F-0A1B2C3D4E5F';
const VIEWER = '0d9e8f7a-6b5c-4d3e-9f1a-2b3c4d5e6f70';
const OTHER_VIEWER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEST_ID = 'data-sharing-opt-in-feed-activity';

type Scopes = ViewerDataSharingStatus['scopes'];

function scopes(overrides: Partial<Scopes> = {}): Scopes {
  const unknown: ViewerDataSharingScopeStatus = 'unknown';
  return {
    metadata: unknown,
    plans: unknown,
    summaries: unknown,
    transcripts: unknown,
    ...overrides,
  };
}

function ready(
  overrides: Partial<Scopes> = {},
  viewerUserId: string = VIEWER,
): ViewerDataSharingLoadState {
  return {
    state: 'ready',
    status: { viewerUserId, scopes: scopes(overrides) },
  };
}

function memoryStore(): DataSharingOptInDismissalStore {
  const raw = new Map<string, string>();
  const storage: DataSharingOptInDismissalStorage = {
    getItem: (key) => raw.get(key) ?? null,
    setItem: (key, value) => {
      raw.set(key, value);
    },
    removeItem: (key) => {
      raw.delete(key);
    },
  };
  return createDataSharingOptInDismissalStore({
    getStorage: () => storage,
    getEventTarget: () => null,
  });
}

describe('resolveWebDataSharingOptIn', () => {
  it('treats prohibited metadata as managed', () => {
    expect(
      resolveWebDataSharingOptIn('feed-activity', {
        viewerUserId: VIEWER,
        scopes: scopes({ metadata: 'prohibited', plans: 'private' }),
      }),
    ).toEqual({ kind: 'managed' });
  });

  it('offers only with private evidence on an allowed required scope', () => {
    expect(
      resolveWebDataSharingOptIn('leaderboards', {
        viewerUserId: VIEWER,
        scopes: scopes({ metadata: 'shared', plans: 'private' }),
      }),
    ).toEqual({
      kind: 'offer',
      allowedScopes: ['metadata', 'plans'],
      skippedScopes: [],
    });
  });

  it('offers on an unknown required scope even when unrelated scopes are private', () => {
    expect(
      resolveWebDataSharingOptIn('leaderboards', {
        viewerUserId: VIEWER,
        scopes: scopes({ metadata: 'shared', transcripts: 'private' }),
      }),
    ).toEqual({
      kind: 'offer',
      allowedScopes: ['metadata', 'plans'],
      skippedScopes: [],
    });
  });

  it('says nothing once every allowed required scope is shared', () => {
    expect(
      resolveWebDataSharingOptIn('leaderboards', {
        viewerUserId: VIEWER,
        scopes: scopes({ metadata: 'shared', plans: 'shared' }),
      }),
    ).toEqual({ kind: 'none' });
  });

  it('never offers for a gap that policy alone explains', () => {
    expect(
      resolveWebDataSharingOptIn('leaderboards', {
        viewerUserId: VIEWER,
        scopes: scopes({ metadata: 'shared', plans: 'prohibited' }),
      }),
    ).toEqual({ kind: 'none' });
  });

  it('discloses prohibited scopes as skipped', () => {
    expect(
      resolveWebDataSharingOptIn('feed-activity', {
        viewerUserId: VIEWER,
        scopes: scopes({ metadata: 'private', summaries: 'prohibited' }),
      }),
    ).toEqual({
      kind: 'offer',
      allowedScopes: ['metadata', 'plans'],
      skippedScopes: ['summaries'],
    });
  });

  it('offers over every required scope from unknown evidence alone', () => {
    expect(
      resolveWebDataSharingOptIn('feed-activity', {
        viewerUserId: VIEWER,
        scopes: scopes(),
      }),
    ).toEqual({
      kind: 'offer',
      allowedScopes: ['metadata', 'plans', 'summaries'],
      skippedScopes: [],
    });
  });

  it('offers on unknown metadata while skipping a prohibited feature scope', () => {
    expect(
      resolveWebDataSharingOptIn('feed-activity', {
        viewerUserId: VIEWER,
        scopes: scopes({ summaries: 'prohibited' }),
      }),
    ).toEqual({
      kind: 'offer',
      allowedScopes: ['metadata', 'plans'],
      skippedScopes: ['summaries'],
    });
  });
});

describe('WebDataSharingOptIn', () => {
  let container: HTMLElement;
  let root: Root;
  let store: DataSharingOptInDismissalStore;

  beforeEach(() => {
    store = memoryStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    sharing: ViewerDataSharingLoadState,
    overrides: Partial<WebDataSharingOptInProps> = {},
  ): void {
    act(() => {
      root.render(
        <TestSettingsHost host={brandHost}>
          <WebDataSharingOptIn
            feature="feed-activity"
            orgId={ORG_ID}
            organizationName="Acme, Inc."
            mobileBrowser={false}
            sharing={sharing}
            dismissalStore={store}
            {...overrides}
          />
        </TestSettingsHost>,
      );
    });
  }

  function hint(): HTMLElement | null {
    return container.querySelector(`[data-testid="${TEST_ID}"]`);
  }

  function required(selector: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  }

  it.each<[string, ViewerDataSharingLoadState]>([
    ['idle', { state: 'idle' }],
    ['loading', { state: 'loading' }],
    ['error', { state: 'error' }],
  ])('renders nothing while %s', (_label, sharing) => {
    render(sharing);
    expect(container.innerHTML).toBe('');
  });

  it('offers from unknown-only evidence once the status settles', () => {
    render(ready());
    expect(hint()?.getAttribute('data-opt-in-state')).toBe('offer');
  });

  it('renders the managed notice without an action', () => {
    render(ready({ metadata: 'prohibited', plans: 'private' }));
    expect(hint()?.getAttribute('data-opt-in-state')).toBe('managed');
    expect(hint()?.textContent).toContain('Acme, Inc. manages this sharing.');
    expect(container.querySelector(`[data-testid="${TEST_ID}-enable"]`)).toBe(
      null,
    );
  });

  it('offers the parameterized desktop link as the only action', () => {
    render(ready({ metadata: 'private' }));
    expect(hint()?.getAttribute('data-opt-in-state')).toBe('offer');
    const enable = required(`[data-testid="${TEST_ID}-enable"]`);
    expect(enable.getAttribute('href')).toBe(
      `${canopyBrand.internalName}://settings/privacy?feature=feed-activity&org=${ORG_ID.toLowerCase()}`,
    );
    // The bare Privacy fallback appears only after the link is followed.
    expect(container.querySelector(`[data-testid="${TEST_ID}-fallback"]`)).toBe(
      null,
    );
    expect(hint()?.textContent).toContain(
      `You'll review this in the ${canopyBrand.displayName} desktop app first.`,
    );
  });

  // Policy-blocked kinds are named in the desktop review, not the web hint.
  it('leaves policy-blocked scopes to the desktop review', () => {
    render(ready({ metadata: 'private', summaries: 'prohibited' }));
    expect(hint()?.getAttribute('data-opt-in-state')).toBe('offer');
    expect(container.querySelector(`[data-testid="${TEST_ID}-summary"]`)).toBe(
      null,
    );
  });

  it('gives mobile browsers text instructions instead of a link', () => {
    render(ready({ metadata: 'private' }), { mobileBrowser: true });
    expect(hint()?.getAttribute('data-opt-in-state')).toBe('offer');
    expect(container.querySelector(`[data-testid="${TEST_ID}-enable"]`)).toBe(
      null,
    );
    expect(container.querySelector('a')).toBe(null);
    expect(required(`[data-testid="${TEST_ID}-mobile"]`).textContent).toBe(
      `Turn this on in the ${canopyBrand.displayName} desktop app.`,
    );
  });

  it('waits on the desktop after activation and never claims success', () => {
    render(ready({ metadata: 'private' }));
    const enable = required(`[data-testid="${TEST_ID}-enable"]`);
    // Keep jsdom from attempting navigation to the custom scheme.
    enable.addEventListener('click', (event) => event.preventDefault());
    act(() => {
      enable.click();
    });
    expect(hint()?.getAttribute('data-opt-in-state')).toBe('awaiting-desktop');
    expect(hint()?.textContent).toContain(
      `Continue in the ${canopyBrand.displayName} desktop app.`,
    );
    expect(
      required(`[data-testid="${TEST_ID}-fallback"]`).getAttribute('href'),
    ).toBe(`${canopyBrand.internalName}://settings/privacy`);

    // Fresh evidence for the same identity does not turn into "saved".
    render(ready({ metadata: 'private' }));
    expect(hint()?.getAttribute('data-opt-in-state')).toBe('awaiting-desktop');
  });

  it('resets the awaiting state when the identity changes', () => {
    render(ready({ metadata: 'private' }));
    const enable = required(`[data-testid="${TEST_ID}-enable"]`);
    enable.addEventListener('click', (event) => event.preventDefault());
    act(() => {
      enable.click();
    });
    expect(hint()?.getAttribute('data-opt-in-state')).toBe('awaiting-desktop');

    render(ready({ metadata: 'private' }, OTHER_VIEWER));
    expect(hint()?.getAttribute('data-opt-in-state')).toBe('offer');
  });

  it('persists a dismissal for this viewer only', () => {
    render(ready({ metadata: 'private' }));
    act(() => {
      required(`[data-testid="${TEST_ID}-dismiss"]`).click();
    });
    expect(hint()).toBe(null);

    // A remount reads the stored dismissal.
    act(() => root.render(<div />));
    render(ready({ metadata: 'private' }));
    expect(hint()).toBe(null);

    // Another account in the same browser still sees its own hint.
    render(ready({ metadata: 'private' }, OTHER_VIEWER));
    expect(hint()?.getAttribute('data-opt-in-state')).toBe('offer');
  });

  it('shows the hint when storage is unavailable', () => {
    store = createDataSharingOptInDismissalStore({
      getStorage: () => {
        throw new Error('SecurityError');
      },
      getEventTarget: () => null,
    });
    render(ready({ metadata: 'private' }));
    expect(hint()?.getAttribute('data-opt-in-state')).toBe('offer');
  });
});
