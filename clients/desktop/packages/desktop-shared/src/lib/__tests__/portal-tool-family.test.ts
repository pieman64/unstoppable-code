import { BRAND } from '@canopy/brand/current';
import { getPortalChatToolFamily } from '../portal-tool-family';
import { CANOPY_INJECTED_TOOL_ENTRIES } from '../canopy-injected-tools';

describe('historical delegate watch Portal family', () => {
  it.each([
    'WatchDelegates',
    `mcp__${BRAND.tools.namespace}__WatchDelegates`,
    `${BRAND.tools.namespace}_watch_delegates`,
    'mcp__old-brand__WatchDelegates',
    'old-brand_watch_delegates',
  ])('keeps %s in the app family without listing it', (name) => {
    expect(
      CANOPY_INJECTED_TOOL_ENTRIES.map((tool) => tool.canonicalKey),
    ).not.toContain('watch_delegates');
    expect(getPortalChatToolFamily(name)).toBe('canopy');
  });
  it('rejects lookalikes and absent names', () => {
    expect(getPortalChatToolFamily(null)).toBe('unknown');
    expect(getPortalChatToolFamily('WatchDelegatesExtra')).not.toBe('canopy');
  });
});
