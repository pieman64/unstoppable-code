import { chatTabLabel } from '@canopy/protocol';
import { useChatStore } from '@/stores/chatStore';
import { worktreeKey } from '@/stores/chat/utils';
import {
  getSidebarProjectEntries,
  useStandaloneChatStore,
} from '@/stores/standaloneChatStore';

/**
 * The name a Cowork entry's sidebar row shows: its rename, else its latest
 * chat's label. Until the rows load, the given chat's own label stands in.
 * Undefined when neither is known, so callers fall back to their own label.
 */
export function useCoworkEntryLabel(
  projectId: string | undefined,
  entryId: string | undefined,
  chatId: string | undefined,
): string | undefined {
  const entryTitle = useStandaloneChatStore((state) =>
    projectId === undefined || entryId === undefined
      ? undefined
      : getSidebarProjectEntries(state, projectId).find(
          (entry) => entry.id === entryId,
        )?.title,
  );
  const chatLabel = useChatStore((state) => {
    if (projectId === undefined || entryId === undefined) return undefined;
    const tab = state.worktreeChats[
      worktreeKey({ projectId, worktreeId: entryId })
    ]?.tabs.find((entry) => entry.id === chatId);
    return tab === undefined ? undefined : chatTabLabel(tab);
  });
  return (entryTitle ?? chatLabel)?.trim() || undefined;
}
