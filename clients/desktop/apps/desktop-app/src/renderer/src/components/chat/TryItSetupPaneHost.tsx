import type { JSX } from 'react';
import { McpOAuthBrowser } from '@/components/plugins/McpOAuthBrowser';
import { useTryItSetupPane } from '@/stores/tryItSetupPaneStore';

/**
 * The Try it authorization pane beside its chat column (CAN-4451). Only the
 * chat whose attempt opened it renders it; closing cancels that attempt.
 */
export function TryItSetupPaneHost({
  projectId,
  worktreeId,
  chatId,
  visible,
}: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  visible: boolean;
}): JSX.Element | null {
  const pane = useTryItSetupPane({ projectId, worktreeId, chatId });
  if (!pane) return null;
  return (
    <McpOAuthBrowser
      key={pane.url}
      url={pane.url}
      owner={pane.attempt}
      title={`Authorize ${pane.capabilityName}`}
      visible={visible}
      // The page is a single-use sign-in: the default browser starts a fresh
      // flow from the notice instead.
      allowExternalOpen={false}
      focusOnOpen
      onClose={pane.onClose}
      onError={pane.onError}
      testId="try-it-setup-pane"
      // Beside the chat column when both fit; below 40rem it covers the
      // transcript instead of squeezing the column (CAN-4404). The notice,
      // with Cancel, and the composer stay above it.
      className="absolute inset-0 z-20 flex flex-col bg-base px-4 pt-3 @min-[40rem]/try-it:static @min-[40rem]/try-it:z-auto @min-[40rem]/try-it:w-[min(28rem,45%)] @min-[40rem]/try-it:min-w-72 @min-[40rem]/try-it:shrink-0 @min-[40rem]/try-it:border-l"
    />
  );
}
