/** @jest-environment jsdom */
// The Cursor tile on the Accounts page shares the Claude / Codex tile
// composition: logo, title, status dot, and the primary account action
// pinned to the header's trailing edge as the tile's only connected-state
// control, with the subscription tier on the signed-in line. These tests
// pin that composition per connection state.
// The App Advisor slice is exercised by its own tests; here it would only
// pull every renderer store into the snapshot builder.
let mockCursorCarryover: {
  provider: 'cursor';
  skills: number;
  commands: number;
  plugins: number;
  attention: string[];
} | null = null;
jest.mock('@/hooks/useProviderCarryover', () => ({
  useProviderCarryover: (): typeof mockCursorCarryover => mockCursorCarryover,
}));
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => {},
}));
// The plan line reads the shared account-usage summary; the store's IPC
// plumbing is covered by its own tests, so it is a plain state object here.
let mockCursorUsage: ProviderUsageSummary | null = null;
const mockRefreshingProviders = new Set<string>();
const mockRefreshUsage = jest.fn(() => Promise.resolve(usageOverview()));
jest.mock('@/stores/observabilityStore', () => {
  const state = {
    get usage(): AgentUsageOverview {
      return usageOverview();
    },
    get refreshingProviders(): Set<string> {
      return mockRefreshingProviders;
    },
    initialize: (): Promise<void> => Promise.resolve(),
    get refreshProviderUsageDetails(): typeof mockRefreshUsage {
      return mockRefreshUsage;
    },
  };
  return {
    useObservabilityStore: (selector: (s: typeof state) => unknown): unknown =>
      selector(state),
  };
});
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AgentUsageOverview,
  CursorAccount,
  CursorConnectionStatus,
  ProviderUsageSummary,
} from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import { requireByTestId } from '@/test-utils/dom';
import {
  expectReplayBlocksOnlyValue,
  outermostReplayBlock,
} from '@/test-utils/replay';
import { CursorConnection } from '../CursorConnection';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function usageOverview(): AgentUsageOverview {
  return {
    updatedAt: '2026-09-30T00:00:00.000Z',
    providers: mockCursorUsage ? [mockCursorUsage] : [],
  };
}

const PRO_PLAN: ProviderUsageSummary = {
  provider: 'cursor',
  authState: 'authenticated',
  hasRemainingLimits: true,
  accountEmail: 'fixture@example.test',
  accountLabel: 'fixture@example.test',
  subscriptionLabel: 'Pro',
};

const CONNECTED: CursorConnectionStatus = {
  supported: true,
  installed: true,
  enabled: true,
  version: 'test',
  phase: 'connected',
  archiveBytes: 174_000_000,
};

const NOT_INSTALLED: CursorConnectionStatus = {
  ...CONNECTED,
  installed: false,
  enabled: false,
  phase: 'idle',
};

interface Scenario {
  status: CursorConnectionStatus;
  /** Result of the account probe; `'fail'` rejects it, `'pending'` never answers. */
  account: CursorAccount | null | 'fail' | 'pending';
  /** `'pending'` holds Connect open so the in-progress state can be observed. */
  connect?: 'pending';
  /** `'reject'` fails Change account after its sign-out, as a cancel does. */
  changeAccount?: 'reject';
  /** Answer for account probes after the first, when they should differ. */
  accountThen?: 'pending';
}

let root: Root | null = null;
let container: HTMLElement | null = null;
let accountReads = 0;
const mockOpenExternal = jest.fn<Promise<void>, [{ url: string }]>(() =>
  Promise.resolve(),
);
const originalApi = Object.getOwnPropertyDescriptor(window, 'api');

async function renderScenario(scenario: Scenario): Promise<void> {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      cursorConnection: {
        status: (): Promise<CursorConnectionStatus> =>
          Promise.resolve(scenario.status),
        account: (): Promise<CursorAccount | null> => {
          accountReads += 1;
          if (accountReads > 1 && scenario.accountThen === 'pending')
            return new Promise<CursorAccount | null>(() => {});
          return scenario.account === 'fail'
            ? Promise.reject(new Error('read failed'))
            : scenario.account === 'pending'
              ? new Promise<CursorAccount | null>(() => {})
              : Promise.resolve(scenario.account);
        },
        connect: (): Promise<CursorConnectionStatus> =>
          scenario.connect === 'pending'
            ? new Promise<CursorConnectionStatus>(() => {})
            : Promise.resolve({
                ...CONNECTED,
                account: { email: 'fixture@example.test' },
              }),
        cancel: (): Promise<void> => Promise.resolve(),
        disconnect: (): Promise<void> => Promise.resolve(),
        changeAccount: (): Promise<CursorConnectionStatus> =>
          scenario.changeAccount === 'reject'
            ? Promise.reject(new Error('Sign-in cancelled'))
            : Promise.resolve({
                ...CONNECTED,
                account: { email: 'second@example.test' },
              }),
        listModels: (): Promise<never[]> => Promise.resolve([]),
        onProgress: (): (() => void) => () => {},
      },
      browser: { openExternal: mockOpenExternal },
      loadPreferences: () => Promise.resolve(makeTestPreferences()),
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  act(() => {
    mounted.render(<CursorConnection />);
  });
  // The status read resolves first, then the account probe it unlocks.
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * The tile header: the settings row's first line, which holds the mark, name,
 * and status dot on one side and the account action on the other. The row's
 * body (status lines aside, the install pitch, errors) sits below it.
 */
function header(): HTMLElement {
  const line = requireByTestId('cursor-connection').firstElementChild;
  if (!(line instanceof HTMLElement)) {
    throw new Error('Cursor row has no header line');
  }
  return line;
}

/** Lets queued promise callbacks (connect → preferences → refresh) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  mockCursorUsage = null;
  mockRefreshingProviders.clear();
  mockRefreshUsage.mockClear();
  mockOpenExternal.mockClear();
  accountReads = 0;
});

afterEach(() => {
  const mounted = root;
  if (mounted) {
    act(() => {
      mounted.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  if (originalApi) Object.defineProperty(window, 'api', originalApi);
});

it('leads with the logo and offers Connect Cursor from the header before connecting', async () => {
  await renderScenario({ status: NOT_INSTALLED, account: null });
  const row = header();
  expect(row.contains(requireByTestId('cursor-connection-logo'))).toBe(true);
  expect(
    requireByTestId('cursor-connection-status-dot').classList.contains(
      'bg-destructive',
    ),
  ).toBe(true);
  const connect = requireByTestId('cursor-connect');
  expect(connect.textContent).toBe('Connect Cursor');
  expect(row.contains(connect)).toBe(true);
  expect(requireByTestId('cursor-connection').textContent).toContain(
    '174MB download',
  );
  expect(document.querySelector('[data-testid="cursor-change-account"]')).toBe(
    null,
  );
});

it('tells a connected Cursor user what carried over from their folders', async () => {
  mockCursorUsage = PRO_PLAN;
  mockCursorCarryover = {
    provider: 'cursor',
    skills: 3,
    commands: 1,
    plugins: 0,
    attention: [],
  };
  try {
    await renderScenario({
      status: CONNECTED,
      account: { email: 'fixture@example.test' },
    });
    expect(requireByTestId('provider-carryover-cursor').textContent).toBe(
      'From the folders your Cursor chats read: 3 skills and 1 command, ready in your Cursor chats.',
    );
  } finally {
    mockCursorCarryover = null;
  }
});

it('shows nothing about carry-over while the connected runtime has no signed-in account', async () => {
  mockCursorCarryover = {
    provider: 'cursor',
    skills: 3,
    commands: 1,
    plugins: 0,
    attention: [],
  };
  try {
    await renderScenario({ status: CONNECTED, account: null });
    expect(requireByTestId('cursor-connection-account').textContent).toBe(
      'Sign in to use your Cursor account',
    );
    expect(
      document.querySelector('[data-testid="provider-carryover-cursor"]'),
    ).toBe(null);
  } finally {
    mockCursorCarryover = null;
  }
});

it('shows nothing about carry-over before Cursor is connected', async () => {
  mockCursorCarryover = {
    provider: 'cursor',
    skills: 3,
    commands: 1,
    plugins: 0,
    attention: [],
  };
  try {
    await renderScenario({ status: NOT_INSTALLED, account: null });
    expect(
      document.querySelector('[data-testid="provider-carryover-cursor"]'),
    ).toBe(null);
  } finally {
    mockCursorCarryover = null;
  }
});

it('pins Change account to the header and reads like the peer tiles once connected', async () => {
  mockCursorUsage = PRO_PLAN;
  await renderScenario({
    status: CONNECTED,
    account: { email: 'fixture@example.test' },
  });
  const row = header();
  expect(row.contains(requireByTestId('cursor-connection-logo'))).toBe(true);
  expect(
    requireByTestId('cursor-connection-status-dot').classList.contains(
      'bg-success',
    ),
  ).toBe(true);
  const change = requireByTestId('cursor-change-account');
  expect(change.textContent).toBe('Change account');
  expect(row.contains(change)).toBe(true);
  // The signed-in line is the only status line, as on the peer tiles: the
  // dot already says the runtime is connected.
  expect(
    document.querySelector('[data-testid="cursor-connection-status"]'),
  ).toBe(null);
  // The subscription shares the signed-in line after a middle dot, as on the
  // Claude / Codex tiles; it is not a line of its own.
  expect(requireByTestId('cursor-connection-account').textContent).toBe(
    'Signed in as fixture@example.test · Pro',
  );
  expect(document.querySelector('[data-testid="cursor-connection-plan"]')).toBe(
    null,
  );
  // No body actions or capability blurb: the header action is the tile's
  // only control, as on the peer tiles.
  expect(document.querySelector('[data-testid="cursor-connect"]')).toBe(null);
  const text = requireByTestId('cursor-connection').textContent ?? '';
  expect(text).not.toContain('download');
  expect(text).not.toContain('Chat and pipeline steps');
  expect(text).not.toContain('Changing the account');
});

it('blocks only the signed-in email from session replay', async () => {
  mockCursorUsage = PRO_PLAN;
  await renderScenario({
    status: CONNECTED,
    account: { email: 'fixture@example.test' },
  });
  const line = requireByTestId('cursor-connection-account');
  expect(line.textContent).toBe('Signed in as fixture@example.test · Pro');
  expectReplayBlocksOnlyValue(
    requireByTestId('cursor-connection'),
    'fixture@example.test',
  );
  expect(outermostReplayBlock(line)).toBeNull();
  expect(
    outermostReplayBlock(requireByTestId('cursor-change-account')),
  ).toBeNull();
});

it('omits the tier until the usage read names the signed-in plan', async () => {
  mockCursorUsage = {
    ...PRO_PLAN,
    authState: 'unknown',
    subscriptionLabel: undefined,
  };
  await renderScenario({
    status: CONNECTED,
    account: { email: 'fixture@example.test' },
  });
  expect(requireByTestId('cursor-connection-account').textContent).toBe(
    'Signed in as fixture@example.test',
  );
});

it('joins the tier onto the plain Signed in line when the CLI reports no email', async () => {
  mockCursorUsage = { ...PRO_PLAN, accountEmail: undefined };
  await renderScenario({ status: CONNECTED, account: { email: '' } });
  expect(requireByTestId('cursor-connection-account').textContent).toBe(
    'Signed in · Pro',
  );
});

it('offers Sign in from the header when connected but signed out', async () => {
  await renderScenario({ status: CONNECTED, account: null });
  const signIn = requireByTestId('cursor-change-account');
  expect(signIn.textContent).toBe('Sign in');
  expect(header().contains(signIn)).toBe(true);
  // The dot means signed in, as on the peer tiles.
  expect(
    requireByTestId('cursor-connection-status-dot').classList.contains(
      'bg-destructive',
    ),
  ).toBe(true);
  expect(requireByTestId('cursor-connection-account').textContent).toBe(
    'Sign in to use your Cursor account',
  );
});

it('offers Check again from the header, and never a sign-out, when the account read fails', async () => {
  await renderScenario({ status: CONNECTED, account: 'fail' });
  const retry = requireByTestId('cursor-account-retry');
  expect(retry.textContent).toBe('Check again');
  expect(header().contains(retry)).toBe(true);
  expect(document.querySelector('[data-testid="cursor-change-account"]')).toBe(
    null,
  );
  expect(requireByTestId('cursor-connection-account').textContent).toBe(
    'Could not check the Cursor sign-in',
  );
});

it('offers no account action until the sign-in read resolves', async () => {
  await renderScenario({ status: CONNECTED, account: 'pending' });
  expect(document.querySelector('[data-testid="cursor-change-account"]')).toBe(
    null,
  );
  expect(document.querySelector('[data-testid="cursor-connect"]')).toBe(null);
  expect(requireByTestId('cursor-connection-account').textContent).toBe(
    'Checking sign-in…',
  );
});

it('never attributes a usage read for another account to the signed-in one', async () => {
  mockCursorUsage = {
    ...PRO_PLAN,
    accountEmail: 'previous@example.test',
    accountLabel: 'previous@example.test',
  };
  await renderScenario({
    status: CONNECTED,
    account: { email: 'fixture@example.test' },
  });
  expect(requireByTestId('cursor-connection-account').textContent).toBe(
    'Signed in as fixture@example.test',
  );
});

it('hides the plan while a usage refresh is in flight', async () => {
  mockCursorUsage = PRO_PLAN;
  mockRefreshingProviders.add('cursor');
  await renderScenario({
    status: CONNECTED,
    account: { email: 'fixture@example.test' },
  });
  expect(requireByTestId('cursor-connection-account').textContent).toBe(
    'Signed in as fixture@example.test',
  );
});

it('refreshes the plan once Connect completes', async () => {
  await renderScenario({ status: NOT_INSTALLED, account: null });
  act(() => {
    requireByTestId('cursor-connect').click();
  });
  await settle();
  expect(mockRefreshUsage).toHaveBeenCalledWith('cursor');
  expect(requireByTestId('cursor-connection-account').textContent).toBe(
    'Signed in as fixture@example.test',
  );
});

it('keeps Connect disabled and offers Cancel setup while setup runs', async () => {
  await renderScenario({
    status: NOT_INSTALLED,
    account: null,
    connect: 'pending',
  });
  act(() => {
    requireByTestId('cursor-connect').click();
  });
  const connect = requireByTestId('cursor-connect');
  expect(header().contains(connect)).toBe(true);
  expect(connect.hasAttribute('disabled')).toBe(true);
  expect(requireByTestId('cursor-connect-cancel').textContent).toBe(
    'Cancel setup',
  );
  expect(mockRefreshUsage).not.toHaveBeenCalled();
});

it('keeps the plan when Cursor provided no usage details for the account', async () => {
  // `unsupported` means no rate limits, not no plan: the read still names
  // the tier for the verified account.
  mockCursorUsage = {
    ...PRO_PLAN,
    hasRemainingLimits: false,
    errorInfo: {
      kind: 'unsupported',
      message: 'Cursor has not provided usage details for this account.',
    },
  };
  await renderScenario({
    status: CONNECTED,
    account: { email: 'fixture@example.test' },
  });
  expect(requireByTestId('cursor-connection-account').textContent).toBe(
    'Signed in as fixture@example.test · Pro',
  );
});

it('refreshes the plan once Change account completes', async () => {
  await renderScenario({
    status: CONNECTED,
    account: { email: 'fixture@example.test' },
  });
  act(() => {
    requireByTestId('cursor-change-account').click();
  });
  await settle();
  expect(mockRefreshUsage).toHaveBeenCalledWith('cursor');
  expect(requireByTestId('cursor-connection-account').textContent).toBe(
    'Signed in as second@example.test',
  );
});

it('refreshes the plan when Change account fails after its sign-out', async () => {
  await renderScenario({
    status: CONNECTED,
    account: { email: 'fixture@example.test' },
    changeAccount: 'reject',
    accountThen: 'pending',
  });
  act(() => {
    requireByTestId('cursor-change-account').click();
  });
  await settle();
  expect(mockRefreshUsage).toHaveBeenCalledWith('cursor');
  // The old account is not named again until the re-read answers.
  expect(requireByTestId('cursor-connection-account').textContent).toBe(
    'Checking sign-in…',
  );
});

describe('Grok hint', () => {
  const byTestId = (testId: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  it('sits collapsed inside the Cursor row instead of a Grok row of its own', async () => {
    await renderScenario({ status: NOT_INSTALLED, account: null });
    const cursorRow = requireByTestId('cursor-connection');
    expect(byTestId('grok-account')).toBe(null);
    const toggle = requireByTestId('grok-unify-toggle');
    expect(cursorRow.contains(toggle)).toBe(true);
    expect(toggle.textContent).toBe('Only have a Grok account?');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.contains(requireByTestId('grok-unify-logo'))).toBe(true);
    // Collapsed, it offers no unify action for a Cursor account to misread.
    expect(byTestId('grok-unify-accounts')).toBe(null);
  });

  it('expands to say how a Grok plan reaches Cursor', async () => {
    await renderScenario({ status: NOT_INSTALLED, account: null });
    const toggle = requireByTestId('grok-unify-toggle');
    act(() => {
      toggle.click();
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const body = requireByTestId('grok-unify-body');
    // The toggle names the region it reveals.
    const controlled = document.getElementById(
      toggle.getAttribute('aria-controls') ?? '',
    );
    expect(controlled?.contains(body)).toBe(true);
    expect(body.textContent).toContain('Grok is now merged with Cursor');
    expect(body.textContent).toContain(
      'To use your Grok plan here, unify your accounts, then sign in with Cursor.',
    );
    expect(body.textContent).toContain(
      "Once they're unified, your plan shows next to your Cursor sign-in.",
    );
    const unify = requireByTestId('grok-unify-accounts');
    expect(unify.textContent).toBe('Unify accounts');
    act(() => {
      unify.click();
    });
    expect(mockOpenExternal).toHaveBeenCalledWith({
      url: 'https://cursor.com/unify',
    });
    act(() => {
      toggle.click();
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    expect(byTestId('grok-unify-body')).toBe(null);
  });

  it('stays collapsed once a Cursor account is signed in', async () => {
    await renderScenario({
      status: CONNECTED,
      account: { email: 'fixture@example.test' },
    });
    expect(
      requireByTestId('grok-unify-toggle').getAttribute('aria-expanded'),
    ).toBe('false');
    expect(byTestId('grok-unify-accounts')).toBe(null);
    // Grok has no connection of its own, so the hint shows no status dot.
    expect(
      requireByTestId('grok-unify').querySelector(
        '[data-testid$="status-dot"]',
      ),
    ).toBeNull();
  });

  it('is absent wherever Cursor cannot be connected', async () => {
    await renderScenario({
      status: { ...NOT_INSTALLED, supported: false },
      account: null,
    });
    expect(byTestId('grok-unify')).toBe(null);
  });
});
