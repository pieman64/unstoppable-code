import { SKILLS_CHANNELS } from '@canopy/desktop-shared/constants/skill-channels';
import { sendToAllWindows } from '../lib/window-send';

/**
 * Tells every window that local skills changed outside it, so open skill
 * inventories refresh. Renderer-initiated skill changes announce themselves in
 * the renderer and do not call this.
 */
export function notifyRenderersSkillsChanged(): void {
  sendToAllWindows(SKILLS_CHANNELS.CHANGED);
}
