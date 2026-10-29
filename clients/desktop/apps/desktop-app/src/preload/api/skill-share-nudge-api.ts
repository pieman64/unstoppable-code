import { ipcRenderer } from '../ipc-router';
import {
  SKILL_SHARE_NUDGE_CHANNELS,
  type SkillShareNudgeAPI,
  type SkillShareNudgeOrigin,
} from '@canopy/desktop-shared/lib/skill-share-nudge';

export function createSkillShareNudgeAPI(): SkillShareNudgeAPI {
  return {
    getPending: (origin) =>
      ipcRenderer.invoke(SKILL_SHARE_NUDGE_CHANNELS.getPending, origin),
    resolve: (request) =>
      ipcRenderer.invoke(SKILL_SHARE_NUDGE_CHANNELS.resolve, request),
    onChanged: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        origin: SkillShareNudgeOrigin,
      ): void => callback(origin);
      ipcRenderer.on(SKILL_SHARE_NUDGE_CHANNELS.changed, listener);
      return () => {
        ipcRenderer.removeListener(
          SKILL_SHARE_NUDGE_CHANNELS.changed,
          listener,
        );
      };
    },
  };
}
