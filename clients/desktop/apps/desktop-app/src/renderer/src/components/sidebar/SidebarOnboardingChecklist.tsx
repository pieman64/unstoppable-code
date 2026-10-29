import type { JSX } from 'react';
import { isCoworkChatTarget } from '@/lib/cowork';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  setOnboardingSidebarHost,
  useOnboardingSuggestionSurfaces,
} from '@/stores/onboardingSuggestionSurfacesStore';

/** Compact host for the same persistent suggestion queue shown on Home. */
export function SidebarOnboardingChecklist(): JSX.Element | null {
  const hasRows = useOnboardingSuggestionSurfaces((s) => s.sidebarHasRows);
  const homeCardMounted = useOnboardingSuggestionSurfaces(
    (s) => s.home !== null,
  );
  const chatCardMounted = useOnboardingSuggestionSurfaces(
    (s) => s.chat !== null,
  );
  const chatProjectId = useOnboardingSuggestionSurfaces(
    (s) => s.chatBrowserTarget?.projectId ?? null,
  );
  const activePage = useNavigationStore((s) => s.activePage);
  // On Home the full card under the composer owns the queue, so the footer
  // card would be a duplicate. Layouts without that card keep this one.
  if (activePage === 'home' && homeCardMounted) return null;
  // An empty chat's full card owns the queue while that chat is on screen.
  // Hidden MainPage chats keep their host registered on other pages, and the
  // store has one `chat` slot, so match the registered chat to the page that
  // shows it: code chats on the main and kanban pages (App.tsx keeps MainPage
  // on screen for both), cowork chats on the chat page.
  const chatOnScreen =
    chatCardMounted &&
    chatProjectId !== null &&
    (isCoworkChatTarget(chatProjectId)
      ? activePage === 'chat'
      : activePage === 'main' || activePage === 'kanban');
  if (chatOnScreen) return null;
  if (!hasRows) return null;
  return <div ref={setOnboardingSidebarHost} />;
}
