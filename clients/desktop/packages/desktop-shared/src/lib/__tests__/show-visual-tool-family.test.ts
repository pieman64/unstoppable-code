import { getToolCategory } from '../turn-utils';
import { getPortalChatToolFamily } from '../portal-tool-family';

describe('ShowVisual tool family', () => {
  it.each([
    'mcp__canopy__ShowVisual',
    'canopy_show_visual',
    'canopy: ShowVisual',
  ])('categorizes %s as an app tool on desktop and Portal', (name) => {
    expect(getToolCategory(name)).toBe('canopy');
    expect(getPortalChatToolFamily(name)).toBe('canopy');
  });
});
