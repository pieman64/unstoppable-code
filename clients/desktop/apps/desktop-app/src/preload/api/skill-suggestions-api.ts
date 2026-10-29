import { ipcRenderer } from '../ipc-router';
import {
  SKILL_SUGGESTION_CHANNELS,
  type SkillSuggestionChangedEvent,
  type SkillSuggestionsAPI,
} from '@canopy/desktop-shared/lib/skill-suggestions';

export function createSkillSuggestionsAPI(): SkillSuggestionsAPI {
  return {
    getPending: (origin) =>
      ipcRenderer.invoke(SKILL_SUGGESTION_CHANNELS.getPending, origin),
    list: () => ipcRenderer.invoke(SKILL_SUGGESTION_CHANNELS.list),
    resolve: (request) =>
      ipcRenderer.invoke(SKILL_SUGGESTION_CHANNELS.resolve, request),
    onChanged: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        event: SkillSuggestionChangedEvent,
      ): void => callback(event);
      ipcRenderer.on(SKILL_SUGGESTION_CHANNELS.changed, listener);
      return () => {
        ipcRenderer.removeListener(SKILL_SUGGESTION_CHANNELS.changed, listener);
      };
    },
  };
}
