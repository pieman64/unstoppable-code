import { create } from 'zustand';
import { useNavigationStore } from '@/stores/navigationStore';
import { isCloudChatKey } from './cloud-ids';

interface CloudChatSelectionState {
  /** The open cloud chat's key; renderer memory only, never persisted. */
  readonly selectedChatKey: string | null;
}

export const useCloudChatSelection = create<CloudChatSelectionState>()(() => ({
  selectedChatKey: null,
}));

/** Shows one cloud chat on the cloud chat page; ignores anything else. */
export function openCloudChat(chatKey: string): void {
  if (!isCloudChatKey(chatKey)) return;
  useCloudChatSelection.setState({ selectedChatKey: chatKey });
  useNavigationStore.getState().navigate('cloud-chat');
}
