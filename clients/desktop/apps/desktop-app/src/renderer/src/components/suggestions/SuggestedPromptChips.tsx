import { memo, useMemo, type JSX } from 'react';
import { SuggestionRow } from '@canopy/ui-shared';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useCuratedMcpServers } from '@/hooks/useCuratedMcpServers';
import { McpServerLogo } from '@/components/shared/McpServerLogo';
import {
  DEFAULT_GENERIC_PROMPT_ICON,
  GENERIC_PROMPT_ICONS,
} from './genericPromptIcons';
import type { SuggestedPrompt } from './mcpPromptIndex';
import {
  trackSuggestedPromptSelection,
  type SuggestedPromptSurface,
} from './suggestedPromptTelemetry';

export interface SuggestedPromptChipsProps {
  prompts: readonly SuggestedPrompt[];
  surface: SuggestedPromptSurface;
  /**
   * Invoked with the clicked prompt after selection telemetry fires. The
   * caller inserts the text into its composer; the component never sends.
   */
  onSelect: (prompt: SuggestedPrompt) => void;
}

/**
 * Curated MCP logo for a prompt row: the shared circular {@link McpServerLogo}
 * at chip size, keeping the generic-icon tile fallback (prompt rows carry no
 * server name to monogram).
 */
interface PromptLogoProps {
  curatedKey: string;
  logoUrl?: string;
}

function PromptLogo({ curatedKey, logoUrl }: PromptLogoProps): JSX.Element {
  return (
    <McpServerLogo
      curatedKey={curatedKey}
      logoUrl={logoUrl}
      size={20}
      imgTestId="suggested-prompt-logo"
      fallbackTestId="suggested-prompt-logo-fallback"
    />
  );
}

/**
 * Suggested prompts for empty-state surfaces (CAN-1809), rendered as a
 * left-aligned list of icon + text rows. MCP-specific prompts show the
 * curated catalog logo; generic fallbacks show a Central Icon. Renders nothing
 * while `prompts` is empty.
 */
export const SuggestedPromptChips = memo(function SuggestedPromptChips({
  prompts,
  surface,
  onSelect,
}: SuggestedPromptChipsProps): JSX.Element | null {
  const { entries } = useCuratedMcpServers();
  const logoByKey = useMemo(() => {
    const map = new Map<string, string | undefined>();
    for (const entry of entries) map.set(entry.key, entry.logoUrl);
    return map;
  }, [entries]);

  if (prompts.length === 0) return null;
  return (
    <div data-testid="suggested-prompt-chips" className="flex w-full flex-col">
      {prompts.map((prompt, index) => (
        <SuggestionRow
          key={prompt.id}
          data-testid="suggested-prompt-chip"
          data-suggestion-id={prompt.id}
          onClick={(): void => {
            trackSuggestedPromptSelection(surface, prompt, index);
            onSelect(prompt);
          }}
          icon={
            prompt.curatedKey !== null ? (
              <PromptLogo
                curatedKey={prompt.curatedKey}
                logoUrl={logoByKey.get(prompt.curatedKey)}
              />
            ) : (
              <span className="flex shrink-0 items-center justify-center fg-tertiary">
                {GENERIC_PROMPT_ICONS[prompt.id] ?? DEFAULT_GENERIC_PROMPT_ICON}
              </span>
            )
          }
        >
          {/* Catalog prompts are app copy; a project starter prompt is
              written by its users, so its text is blocked. */}
          <span
            className={
              prompt.userAuthored ? POSTHOG_REPLAY_BLOCK_CLASS : undefined
            }
          >
            {prompt.text}
          </span>
        </SuggestionRow>
      ))}
    </div>
  );
});
