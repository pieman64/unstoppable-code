/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  useShareAudience,
  type UseShareAudienceOptions,
  type UseShareAudienceResult,
} from '../useShareAudience';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('useShareAudience', () => {
  let container: HTMLElement;
  let root: Root;
  let latest: UseShareAudienceResult | null = null;

  function Harness(props: UseShareAudienceOptions): JSX.Element {
    latest = useShareAudience(props);
    return <span />;
  }

  function render(props: UseShareAudienceOptions): void {
    act(() => {
      root.render(<Harness {...props} />);
    });
  }

  beforeEach(() => {
    latest = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('starts on Team or Organization, or the initial one', () => {
    render({ offered: ['team', 'public'], availability: {} });
    expect(latest?.audience).toBe('team');
    act(() => root.unmount());
    root = createRoot(container);
    render({
      offered: ['team', 'organization', 'public'],
      availability: {},
      initial: 'public',
    });
    expect(latest?.audience).toBe('public');
  });

  it('never falls back to Private', () => {
    const offered = ['team', 'organization'] as const;
    render({ offered, availability: { team: true } });
    expect(latest?.audience).toBe('team');
    render({ offered, availability: { team: false } });
    expect(latest?.audience).toBe('organization');
    render({ offered, availability: { team: false, organization: false } });
    expect(latest?.audience).toBeNull();
  });

  it('ignores a Private initial audience', () => {
    render({
      offered: ['team', 'organization', 'public'],
      availability: {},
      initial: 'private',
    });
    expect(latest?.audience).toBe('team');
  });

  it('selects Public when it is the only usable audience', () => {
    render({
      offered: ['team', 'organization', 'public'],
      availability: { team: false, organization: false },
    });
    expect(latest?.audience).toBe('public');
  });

  it('does not preselect Public while Team or Organization is usable', () => {
    render({
      offered: ['team', 'public'],
      availability: { team: true },
    });
    expect(latest?.audience).toBe('team');
  });

  it('waits for availability before selecting the only usable audience', () => {
    const offered = ['team', 'organization', 'public'] as const;
    render({
      offered,
      availability: { team: false, organization: false },
      ready: false,
    });
    expect(latest?.audience).toBe('team');
    render({
      offered,
      availability: { team: true, organization: true },
      ready: true,
    });
    expect(latest?.audience).toBe('team');
  });

  it('selects nothing when no offered audience is usable', () => {
    render({
      offered: ['team', 'organization', 'public'],
      availability: { team: false, organization: false, public: false },
    });
    expect(latest?.audience).toBeNull();
  });

  it('moves to the only usable audience when availability arrives later', () => {
    const offered = ['team', 'organization', 'public'] as const;
    render({ offered, availability: {} });
    expect(latest?.audience).toBe('team');
    render({
      offered,
      availability: { team: false, organization: false, public: true },
    });
    expect(latest?.audience).toBe('public');
  });

  it('still prefers Team or Organization over the only-usable fallback', () => {
    render({
      offered: ['team', 'organization', 'public'],
      availability: { team: false, organization: true, public: true },
    });
    expect(latest?.audience).toBe('organization');
  });

  it('selects the sole audience of a single-audience resource', () => {
    render({ offered: ['public'], availability: {} });
    expect(latest?.audience).toBe('public');
  });

  it('falls back to Organization when the account has no team', () => {
    render({
      offered: ['team', 'organization', 'public'],
      availability: { team: false, organization: true },
    });
    expect(latest?.audience).toBe('organization');
  });

  it('keeps an existing audience until availability is known', () => {
    const offered = ['team', 'organization'] as const;
    render({
      offered,
      availability: { team: false },
      initial: 'team',
      ready: false,
    });
    expect(latest?.audience).toBe('team');
    render({ offered, availability: { team: true }, initial: 'team' });
    expect(latest?.audience).toBe('team');
  });

  it('adopts an existing audience that loads after the dialog opens', () => {
    const offered = ['team', 'organization', 'public'] as const;
    render({ offered, availability: { team: true }, ready: true });
    expect(latest?.audience).toBe('team');

    render({
      offered,
      availability: { team: true },
      initial: 'public',
      ready: true,
    });
    expect(latest?.audience).toBe('public');
  });
});
