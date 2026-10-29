import type { JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import type { ChatBannerTarget } from '@/stores/aiCreditsBannerStore';
import { useOllamaConnectionUnavailable } from '@/stores/ollamaConnectionBannerStore';
import { useNavigationStore } from '@/stores/navigationStore';

interface OllamaConnectionBannerProps {
  target: ChatBannerTarget | null;
}

export function OllamaConnectionBanner({
  target,
}: OllamaConnectionBannerProps): JSX.Element | null {
  const unavailable = useOllamaConnectionUnavailable(target);
  const openSettings = useNavigationStore((state) => state.openSettings);

  if (!target || !unavailable) return null;

  return (
    <Notice
      intent="attention"
      title="Ollama server not reachable"
      data-testid="chat-input-ollama-unavailable-banner"
      actions={
        <NoticeButton
          variant="secondary"
          onClick={(): void => openSettings('ollama')}
        >
          Open Ollama settings
        </NoticeButton>
      }
    >
      Start it or check its connection settings.
    </Notice>
  );
}
