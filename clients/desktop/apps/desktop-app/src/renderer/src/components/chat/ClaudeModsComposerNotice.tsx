import { memo, useState, type JSX } from 'react';
import type { ClaudeModsSkippedEntry } from '@canopy/agent-transcript/types';
import type { ClaudeModsChatContext } from '@canopy/protocol/claude-mods';
import { ClaudeModsSkippedNoticeView } from '@canopy/ui-app';
import { openClaudeModPluginDetails } from './open-claude-mod-plugin-details';

/** Each chat's dismissed forecast, by the Mods it named; this session only. */
const dismissedModsByChat = new Map<string, string>();

interface ClaudeModsComposerNoticeProps {
  readonly context: ClaudeModsChatContext;
  /** From the chat's discovery: Mods its next launch would leave out. */
  readonly mods: readonly ClaudeModsSkippedEntry[];
}

/**
 * Above the composer, before a message is sent: the plugins this chat turned
 * on whose Mod won't load, with the launch notice's controls. Dismissing
 * hides it until the set of Mods changes. Mount it keyed by chat.
 */
function ClaudeModsComposerNoticeComponent({
  context,
  mods,
}: ClaudeModsComposerNoticeProps): JSX.Element | null {
  const modsKey = mods
    .map((mod) => mod.pluginId)
    .sort()
    .join('\n');
  const [dismissedKey, setDismissedKey] = useState(() =>
    dismissedModsByChat.get(context.chatId),
  );
  if (mods.length === 0 || dismissedKey === modsKey) return null;
  return (
    <ClaudeModsSkippedNoticeView
      mods={mods}
      context={context}
      onOpenDetails={openClaudeModPluginDetails}
      placement="composer"
      onDismiss={(): void => {
        dismissedModsByChat.set(context.chatId, modsKey);
        setDismissedKey(modsKey);
      }}
    />
  );
}

export const ClaudeModsComposerNotice = memo(ClaudeModsComposerNoticeComponent);
