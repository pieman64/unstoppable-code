/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarOnboardingChecklist } from '../SidebarOnboardingChecklist';
import { OnboardingSuggestionSidebar } from '@/components/home/onboarding-suggestions/OnboardingSuggestionSidebar';
import { useOnboardingSuggestionSurfaces } from '@/stores/onboardingSuggestionSurfacesStore';
import { useNavigationStore } from '@/stores/navigationStore';
import type { OnboardingChecklistView } from '@/components/home/onboarding-suggestions/queue';
import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const initialActivePage = useNavigationStore.getState().activePage;
beforeEach(() => {
  useNavigationStore.setState({ activePage: 'plugins' });
  useOnboardingSuggestionSurfaces.setState({
    home: null,
    chat: null,
    chatBrowserTarget: null,
    sidebarHasRows: false,
    queueStatus: 'loading',
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useNavigationStore.setState({ activePage: initialActivePage });
  useOnboardingSuggestionSurfaces.setState({
    home: null,
    chat: null,
    chatBrowserTarget: null,
    sidebar: null,
  });
});

const CODE_PROJECT_ID = 'project-code';
const codeChatTarget = {
  projectId: CODE_PROJECT_ID,
  worktreeId: 'worktree-code',
  chatId: 'chat-code',
};
const coworkChatTarget = {
  projectId: STANDALONE_CHAT_PROJECT_ID,
  worktreeId: 'worktree-cowork',
  chatId: 'chat-cowork',
};

function expectHostRegistered(): void {
  expect(container.firstElementChild).not.toBeNull();
  expect(useOnboardingSuggestionSurfaces.getState().sidebar).toBe(
    container.firstElementChild,
  );
}

function expectHostReleased(): void {
  expect(container.childElementCount).toBe(0);
  expect(useOnboardingSuggestionSurfaces.getState().sidebar).toBeNull();
}

test('leaves no footer element before the queue has a visible suggestion', () => {
  act(() => root.render(<SidebarOnboardingChecklist />));
  expect(container.childElementCount).toBe(0);
});

test('registers and releases the sidebar host without creating another queue owner', () => {
  useOnboardingSuggestionSurfaces.setState({ sidebarHasRows: true });
  act(() => root.render(<SidebarOnboardingChecklist />));
  expect(useOnboardingSuggestionSurfaces.getState().sidebar).toBe(
    container.firstElementChild,
  );
  act(() =>
    useOnboardingSuggestionSurfaces.setState({ sidebarHasRows: false }),
  );
  expect(container.childElementCount).toBe(0);
  expect(useOnboardingSuggestionSurfaces.getState().sidebar).toBeNull();
  act(() => useOnboardingSuggestionSurfaces.setState({ sidebarHasRows: true }));
  expect(useOnboardingSuggestionSurfaces.getState().sidebar).toBe(
    container.firstElementChild,
  );
  act(() => root.render(null));
  expect(useOnboardingSuggestionSurfaces.getState().sidebar).toBeNull();
});

test('leaves the footer to the Home card while Home shows it', () => {
  useNavigationStore.setState({ activePage: 'home' });
  useOnboardingSuggestionSurfaces.setState({
    home: document.createElement('div'),
    sidebarHasRows: true,
  });
  act(() => root.render(<SidebarOnboardingChecklist />));
  expect(container.childElementCount).toBe(0);
  expect(useOnboardingSuggestionSurfaces.getState().sidebar).toBeNull();
});

test('registers the host on leaving Home and releases it on returning', () => {
  useNavigationStore.setState({ activePage: 'home' });
  useOnboardingSuggestionSurfaces.setState({
    home: document.createElement('div'),
    sidebarHasRows: true,
  });
  act(() => root.render(<SidebarOnboardingChecklist />));
  expect(useOnboardingSuggestionSurfaces.getState().sidebar).toBeNull();
  act(() => useNavigationStore.setState({ activePage: 'plugins' }));
  expect(container.firstElementChild).not.toBeNull();
  expect(useOnboardingSuggestionSurfaces.getState().sidebar).toBe(
    container.firstElementChild,
  );
  act(() => useNavigationStore.setState({ activePage: 'home' }));
  expect(container.childElementCount).toBe(0);
  expect(useOnboardingSuggestionSurfaces.getState().sidebar).toBeNull();
});

test('stays empty on Home when the queue has no sidebar rows', () => {
  useNavigationStore.setState({ activePage: 'home' });
  useOnboardingSuggestionSurfaces.setState({
    home: document.createElement('div'),
    sidebarHasRows: false,
  });
  act(() => root.render(<SidebarOnboardingChecklist />));
  expect(container.childElementCount).toBe(0);
});

test('keeps the footer card on Home when Home does not mount its card', () => {
  useNavigationStore.setState({ activePage: 'home' });
  useOnboardingSuggestionSurfaces.setState({ sidebarHasRows: true });
  act(() => root.render(<SidebarOnboardingChecklist />));
  expect(useOnboardingSuggestionSurfaces.getState().sidebar).toBe(
    container.firstElementChild,
  );
  act(() =>
    useOnboardingSuggestionSurfaces.setState({
      home: document.createElement('div'),
    }),
  );
  expect(container.childElementCount).toBe(0);
  expect(useOnboardingSuggestionSurfaces.getState().sidebar).toBeNull();
});

test.each(['main', 'kanban'] as const)(
  'leaves the footer to an empty code chat card on %s',
  (activePage) => {
    useNavigationStore.setState({ activePage });
    useOnboardingSuggestionSurfaces.setState({
      chat: document.createElement('div'),
      chatBrowserTarget: codeChatTarget,
      sidebarHasRows: true,
    });
    act(() => root.render(<SidebarOnboardingChecklist />));
    expectHostReleased();
  },
);

test('leaves the footer to an empty cowork chat card on the chat page', () => {
  useNavigationStore.setState({ activePage: 'chat' });
  useOnboardingSuggestionSurfaces.setState({
    chat: document.createElement('div'),
    chatBrowserTarget: coworkChatTarget,
    sidebarHasRows: true,
  });
  act(() => root.render(<SidebarOnboardingChecklist />));
  expectHostReleased();
});

test.each([
  ['a hidden code chat on the chat page', 'chat', codeChatTarget],
  ['a cowork chat on the main page', 'main', coworkChatTarget],
  ['a hidden code chat on plugins', 'plugins', codeChatTarget],
  ['a code chat on Home without its card', 'home', codeChatTarget],
] as const)(
  'keeps the footer card for %s',
  (_label, activePage, chatBrowserTarget) => {
    useNavigationStore.setState({ activePage });
    useOnboardingSuggestionSurfaces.setState({
      chat: document.createElement('div'),
      chatBrowserTarget,
      sidebarHasRows: true,
    });
    act(() => root.render(<SidebarOnboardingChecklist />));
    expectHostRegistered();
  },
);

test('returns the footer card when the empty chat card goes away', () => {
  useNavigationStore.setState({ activePage: 'main' });
  useOnboardingSuggestionSurfaces.setState({
    chat: document.createElement('div'),
    chatBrowserTarget: codeChatTarget,
    sidebarHasRows: true,
  });
  act(() => root.render(<SidebarOnboardingChecklist />));
  expectHostReleased();
  // The composer received text or the chat received a message.
  act(() =>
    useOnboardingSuggestionSurfaces.setState({
      chat: null,
      chatBrowserTarget: null,
    }),
  );
  expectHostRegistered();
  // A new empty chat publishes its card again.
  act(() =>
    useOnboardingSuggestionSurfaces.setState({
      chat: document.createElement('div'),
      chatBrowserTarget: codeChatTarget,
    }),
  );
  expectHostReleased();
});

test.each([
  ['a chat host without a browser target', true, null],
  ['a browser target without a chat host', false, codeChatTarget],
] as const)(
  'keeps the footer card on a half-published registration: %s',
  (_label, chatMounted, chatBrowserTarget) => {
    useNavigationStore.setState({ activePage: 'main' });
    useOnboardingSuggestionSurfaces.setState({
      chat: chatMounted ? document.createElement('div') : null,
      chatBrowserTarget,
      sidebarHasRows: true,
    });
    act(() => root.render(<SidebarOnboardingChecklist />));
    expectHostRegistered();
  },
);

test('registers the host on leaving an empty chat and releases it on returning', () => {
  useNavigationStore.setState({ activePage: 'main' });
  useOnboardingSuggestionSurfaces.setState({
    chat: document.createElement('div'),
    chatBrowserTarget: codeChatTarget,
    sidebarHasRows: true,
  });
  act(() => root.render(<SidebarOnboardingChecklist />));
  expectHostReleased();
  act(() => useNavigationStore.setState({ activePage: 'plugins' }));
  expectHostRegistered();
  act(() => useNavigationStore.setState({ activePage: 'main' }));
  expectHostReleased();
});

test.each([
  [{ kind: 'add-repo-cta' }, 'Add a project', 'Add project'],
  [{ kind: 'connect-github' }, 'Connect GitHub', 'Connect'],
  [{ kind: 'create-plan' }, 'Try plan mode', 'Try it'],
  [
    { kind: 'linear-try-prompt', promptText: 'Plan a Linear ticket' },
    'Try the Linear plugin',
    'Try it',
  ],
] as const)(
  'shows only the current step and its action: %s',
  (step, title, cta) => {
    const onActivate = jest.fn();
    const view: OnboardingChecklistView = {
      entryId: 'next',
      status: 'pending',
      step,
    };
    act(() =>
      root.render(
        <OnboardingSuggestionSidebar
          view={view}
          nontechnical={false}
          onActivate={onActivate}
          notificationsBusy={false}
          focusShortcutBusy={false}
        />,
      ),
    );
    const action = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-onboarding-suggestion-cta"]',
    );
    expect(action?.textContent).toBe(cta);
    expect(
      container.querySelector(
        '[data-testid="sidebar-onboarding-suggestion-title"]',
      )?.textContent,
    ).toBe(title);
    expect(
      container.querySelector('[data-testid="sidebar-onboarding-progress"]'),
    ).toBeNull();
    act(() => action?.click());
    expect(onActivate).toHaveBeenCalledTimes(1);
  },
);

test('offers a project prerequisite for a deferred plan and allows dismissal', () => {
  const onActivate = jest.fn();
  act(() =>
    root.render(
      <OnboardingSuggestionSidebar
        view={{
          entryId: 'agents',
          status: 'deferred',
          step: { kind: 'create-plan' },
        }}
        nontechnical
        onActivate={onActivate}
        notificationsBusy={false}
        focusShortcutBusy={false}
      />,
    ),
  );
  expect(container.textContent).toContain('Add a project');
  act(() =>
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-onboarding-suggestion-cta"]',
      )
      ?.click(),
  );
  expect(onActivate).toHaveBeenCalledTimes(1);
});
