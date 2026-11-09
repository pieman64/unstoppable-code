/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CURSOR_APPROVAL_CHECK_PROJECT_ID,
  type ApprovalRequestEvent,
} from '@canopy/desktop-shared/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => undefined,
}));
jest.mock('@/lib/cursor-settings-actions', () => ({
  registerCursorSettingsAction: (): (() => void) => () => undefined,
}));

const CARD: ApprovalRequestEvent = {
  requestId: 'cursor-req-1',
  projectId: CURSOR_APPROVAL_CHECK_PROJECT_ID,
  worktreeId: 'cursor-check',
  chatId: 'cursor-check',
  provider: 'cursor',
  surface: 'non-chat',
  title: 'Create the check file',
  details: { kind: 'tool', toolName: 'Write' },
  policyRevision: 1,
};

let root: Root;
let container: HTMLDivElement;

function buttonWithText(text: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find(
    (element) => element.textContent?.trim() === text,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button ${text}`);
  }
  return match;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('a refused stale allow keeps the still-live Cursor approval card', async () => {
  let deliver: (event: ApprovalRequestEvent) => void = () => undefined;
  const respond = jest.fn<Promise<boolean>, [unknown]>(() =>
    Promise.resolve(false),
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: (): Promise<unknown> =>
        Promise.resolve({ cursorAgentPath: '/usr/local/bin/cursor-agent' }),
      cursorApprovalCheck: {
        available: (): Promise<boolean> => Promise.resolve(true),
        run: (): Promise<unknown> => new Promise(() => undefined),
        cancel: (): Promise<void> => Promise.resolve(),
      },
      approvals: {
        onRequest: (listener: (event: ApprovalRequestEvent) => void) => {
          deliver = listener;
          return (): void => undefined;
        },
        onCancelled: (): (() => void) => () => undefined,
        respond,
        pendingRequests: (): Promise<ApprovalRequestEvent[]> =>
          Promise.resolve([{ ...CARD, policyRevision: 2 }]),
      },
    },
  });
  const { CursorApprovalCheck } = await import('../CursorApprovalCheck');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<CursorApprovalCheck />);
  });
  await flush();

  act(() => {
    buttonWithText('Test Cursor approvals').click();
  });
  await flush();
  act(() => {
    deliver(CARD);
  });
  await flush();
  act(() => {
    buttonWithText('Allow once').click();
  });
  await flush();

  expect(respond).toHaveBeenCalledWith(
    expect.objectContaining({ policyRevision: 1 }),
  );
  expect(
    container.querySelector('[data-testid="tool-approval-card"]'),
  ).not.toBeNull();
  expect(container.textContent).not.toContain(
    'This approval is no longer pending.',
  );

  act(() => {
    buttonWithText('Allow once').click();
  });
  await flush();
  expect(respond).toHaveBeenLastCalledWith(
    expect.objectContaining({ policyRevision: 2 }),
  );
});
