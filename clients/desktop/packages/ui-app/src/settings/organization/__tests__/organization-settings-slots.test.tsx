/** @jest-environment jsdom */
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  OrganizationSettingsSlotsProvider,
  useOrgProjectLocalStatuses,
  type OrganizationSettingsSlots,
  type OrgProjectLocalSetupSlot,
  type OrgProjectLocalStatus,
} from '../organization-settings-slots';

let container: HTMLDivElement;
let root: Root;
const reads: {
  statuses: ReadonlyMap<string, OrgProjectLocalStatus>;
}[] = [];

function Probe({ organizationId }: { organizationId: string }): JSX.Element {
  const statuses = useOrgProjectLocalStatuses(organizationId);
  reads.push({ statuses });
  return <span>{statuses.size}</span>;
}

function render(
  slots: OrganizationSettingsSlots,
  organizationId = 'org',
): void {
  act(() => {
    root.render(
      <OrganizationSettingsSlotsProvider slots={slots}>
        <Probe organizationId={organizationId} />
      </OrganizationSettingsSlotsProvider>,
    );
  });
}

/** A slot over a mutable per-organization snapshot. */
function fakeSlot(): {
  slot: OrgProjectLocalSetupSlot;
  set: (
    organizationId: string,
    statuses: Map<string, OrgProjectLocalStatus>,
  ) => void;
  listeners: Map<string, Set<() => void>>;
} {
  const snapshots = new Map<
    string,
    ReadonlyMap<string, OrgProjectLocalStatus>
  >();
  const listeners = new Map<string, Set<() => void>>();
  const empty: ReadonlyMap<string, OrgProjectLocalStatus> = new Map();
  return {
    listeners,
    set: (organizationId, statuses): void => {
      snapshots.set(organizationId, statuses);
      listeners.get(organizationId)?.forEach((listener): void => {
        listener();
      });
    },
    slot: {
      subscribe: (organizationId, onChange): (() => void) => {
        const set = listeners.get(organizationId) ?? new Set<() => void>();
        set.add(onChange);
        listeners.set(organizationId, set);
        return (): void => {
          set.delete(onChange);
        };
      },
      getLocalStatuses: (organizationId) =>
        snapshots.get(organizationId) ?? empty,
      setUp: jest.fn(() => Promise.resolve()),
      open: jest.fn(() => Promise.resolve()),
    },
  };
}

beforeEach(() => {
  reads.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useOrgProjectLocalStatuses', () => {
  it('returns one stable empty Map without a slot', () => {
    render({});
    render({});
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads[0]?.statuses.size).toBe(0);
    expect(reads.at(-1)?.statuses).toBe(reads[0]?.statuses);
  });

  it('reads the slot and re-renders on its change notification', () => {
    const { slot, set } = fakeSlot();
    render({ orgProjectLocalSetup: slot });
    expect(reads.at(-1)?.statuses.size).toBe(0);
    act(() => set('org', new Map([['p1', { state: 'ready' }]])));
    expect(reads.at(-1)?.statuses.get('p1')).toEqual({ state: 'ready' });
    expect(container.textContent).toBe('1');
  });

  it('re-subscribes when the organization changes', () => {
    const { slot, set, listeners } = fakeSlot();
    set('other', new Map([['p2', { state: 'setting-up' }]]));
    render({ orgProjectLocalSetup: slot }, 'org');
    expect(listeners.get('org')?.size).toBe(1);
    render({ orgProjectLocalSetup: slot }, 'other');
    expect(listeners.get('org')?.size).toBe(0);
    expect(listeners.get('other')?.size).toBe(1);
    expect(reads.at(-1)?.statuses.get('p2')).toEqual({ state: 'setting-up' });
  });
});
