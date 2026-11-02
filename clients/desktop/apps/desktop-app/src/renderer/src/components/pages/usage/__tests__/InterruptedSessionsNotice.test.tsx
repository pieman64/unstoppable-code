/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InterruptedSessionsNotice } from '../InterruptedSessionsNotice';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let mockCount = 0;
const mockIsInContext = jest.fn((): boolean => true);
const mockUseInterruptedSessions = jest.fn<
  { count: number; signature: string },
  [boolean, (workspaceId: string) => boolean]
>(() => ({ count: mockCount, signature: String(mockCount) }));
const mockDispatch = jest.fn<Promise<void>, [unknown]>(() => Promise.resolve());

jest.mock('@/hooks/useInterruptedSessions', () => ({
  useInterruptedSessions: (
    active: boolean,
    isInContext: (workspaceId: string) => boolean,
  ): { count: number; signature: string } =>
    mockUseInterruptedSessions(active, isInContext),
}));
jest.mock('@/hooks/useContextScopedWorkspaces', () => ({
  useContextScopedWorkspaces: (): { isInContext: () => boolean } => ({
    isInContext: mockIsInContext,
  }),
}));
jest.mock('@/lib/app-actions/dispatcher', () => ({
  dispatchAppAction: (request: unknown): Promise<void> => mockDispatch(request),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mockCount = 0;
  jest.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('renders nothing while no session is interrupted', () => {
  act(() => root.render(<InterruptedSessionsNotice />));
  expect(container.firstChild).toBeNull();
});

it('counts every interrupted session in the selected workspaces once', () => {
  mockCount = 10;
  act(() => root.render(<InterruptedSessionsNotice />));
  expect(mockUseInterruptedSessions).toHaveBeenCalledWith(
    true,
    mockIsInContext,
  );
  const notice = container.querySelector(
    '[data-testid="usage-interrupted-sessions"]',
  );
  expect(notice?.textContent).toContain('10 sessions were interrupted.');
  expect(
    container.querySelectorAll('[data-testid="usage-interrupted-sessions"]'),
  ).toHaveLength(1);
});

it('uses the singular for one session', () => {
  mockCount = 1;
  act(() => root.render(<InterruptedSessionsNotice />));
  expect(container.textContent).toContain('1 session was interrupted.');
});

it('opens the same review the Home Continue row opens', () => {
  mockCount = 3;
  act(() => root.render(<InterruptedSessionsNotice />));
  const resume = container.querySelector<HTMLButtonElement>(
    '[data-testid="usage-interrupted-sessions-resume"]',
  );
  expect(resume?.textContent).toBe('Resume…');
  act(() => resume?.click());
  expect(mockDispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      source: 'ui',
      action: { type: 'usage.open_resume_modal' },
    }),
  );
});
