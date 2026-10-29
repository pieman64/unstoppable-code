/**
 * @jest-environment jsdom
 */
// eslint-disable-next-line no-restricted-imports -- jsdom needs this test-only TextEncoder polyfill.
import { TextEncoder } from 'node:util';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { useAutomationsStore } from '@/stores/automationsStore';
import {
  AUTOMATIONS_E2E_INSTALL_FIXTURE_EVENT,
  parseAutomationsE2eInstallFixture,
} from '@/lib/automationsE2eInstallFixture';

Object.assign(globalThis, { TextEncoder });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

interface InstallModalProps {
  detail: { id: string; contentHash: string; name: string };
  staleActivities?: ScheduledActivity[];
  workspaces: Array<{ id: string }>;
  onClose: () => void;
}
let mockInstallModalProps: InstallModalProps | null = null;

// The wizard has its own suite; here only what it is opened with matters.
jest.mock('../InstallSharedAutomationModal', () => ({
  InstallSharedAutomationModal: (props: InstallModalProps): JSX.Element => {
    mockInstallModalProps = props;
    return (
      <button
        type="button"
        data-testid="mock-install-modal-close"
        onClick={props.onClose}
      >
        Close
      </button>
    );
  },
}));
jest.mock('@/hooks/useAutomationScope', () => ({
  useAutomationScope: (): Record<string, unknown> => ({
    context: undefined,
    projectsInContext: [
      { id: 'workspace-1', name: 'Canopy', type: 'single-repo' },
    ],
  }),
}));

import { AutomationInstallContinuationHost } from '../AutomationInstallContinuationHost';

const SHARE_ID = '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111';
const CURRENT = 'a'.repeat(64);
const OLDER = 'b'.repeat(64);

const fixtureDocument = {
  version: 2,
  name: 'Triage inbox',
  description: 'Sorts new issues every morning.',
  trigger: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'local' },
  action: { type: 'app_advisor_prompt', prompt: 'Triage', plugins: [] },
  hasRunCondition: false,
};

function activity(id: string, installedHash: string): ScheduledActivity {
  return {
    version: 1,
    id,
    name: 'Triage inbox',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Triage' },
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    failureCount: 0,
    installedFrom: {
      remoteId: SHARE_ID,
      contentHash: installedHash,
      installedAt: '2026-08-19T00:00:00.000Z',
    },
  };
}

function setE2eFlag(value: boolean): void {
  Object.defineProperty(globalThis, '__CANOPY_E2E__', {
    configurable: true,
    writable: true,
    value,
  });
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  mockInstallModalProps = null;
  useAutomationsStore.setState({
    activities: [],
    hydrated: true,
    loading: false,
    error: null,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setE2eFlag(false);
});

async function renderHost(): Promise<void> {
  await act(async () => {
    root.render(<AutomationInstallContinuationHost />);
    await Promise.resolve();
  });
}

async function injectFixture(detail: unknown): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent(AUTOMATIONS_E2E_INSTALL_FIXTURE_EVENT, { detail }),
    );
    await Promise.resolve();
  });
}

const validPayload = {
  id: SHARE_ID,
  contentHash: CURRENT,
  document: fixtureDocument,
};

describe('parseAutomationsE2eInstallFixture', () => {
  it('reads a team share from a valid payload', () => {
    expect(parseAutomationsE2eInstallFixture(validPayload)).toMatchObject({
      id: SHARE_ID,
      name: 'Triage inbox',
      contentHash: CURRENT,
      shareScope: 'team',
      triggerKind: 'cron',
      actionType: 'app_advisor_prompt',
      automation: fixtureDocument,
    });
  });

  it.each<[string, unknown]>([
    ['no payload', null],
    ['a missing id', { contentHash: CURRENT, document: fixtureDocument }],
    ['a missing hash', { id: SHARE_ID, document: fixtureDocument }],
    [
      'an invalid document',
      { id: SHARE_ID, contentHash: CURRENT, document: { name: 'x' } },
    ],
  ])('ignores %s', (_label, payload) => {
    expect(parseAutomationsE2eInstallFixture(payload)).toBeNull();
  });
});

describe('E2E install fixture seam', () => {
  it('stays inert outside E2E builds', async () => {
    setE2eFlag(false);
    await renderHost();
    await injectFixture(validPayload);

    expect(mockInstallModalProps).toBeNull();
  });

  it('opens the install wizard for an injected share from any page', async () => {
    setE2eFlag(true);
    await renderHost();
    await injectFixture(validPayload);

    expect(mockInstallModalProps).toMatchObject({
      detail: { id: SHARE_ID, contentHash: CURRENT, name: 'Triage inbox' },
      staleActivities: [],
      workspaces: [expect.objectContaining({ id: 'workspace-1' })],
    });

    mockInstallModalProps = null;
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="mock-install-modal-close"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="mock-install-modal-close"]'),
    ).toBeNull();
  });

  it('ignores a malformed payload', async () => {
    setE2eFlag(true);
    await renderHost();
    await injectFixture({ id: SHARE_ID });

    expect(mockInstallModalProps).toBeNull();
  });

  it('updates the stale copies in place and installs beside a current one', async () => {
    setE2eFlag(true);
    const staleA = activity('stale-a', OLDER);
    const staleB = activity('stale-b', OLDER);
    useAutomationsStore.setState({ activities: [staleA, staleB] });
    await renderHost();
    await injectFixture(validPayload);

    expect(mockInstallModalProps?.staleActivities).toEqual([staleA, staleB]);

    useAutomationsStore.setState({
      activities: [activity('current', CURRENT)],
    });
    await injectFixture(validPayload);
    expect(mockInstallModalProps?.staleActivities).toEqual([]);
  });
});
