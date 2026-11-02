import { BRAND } from '@canopy/brand/current';
import { getToolCategory } from '../turn-utils';
import { CANOPY_INJECTED_TOOL_ENTRIES } from '../canopy-injected-tools';

describe('historical delegate watch summaries', () => {
  it.each([
    'WatchDelegates',
    `mcp__${BRAND.tools.namespace}__WatchDelegates`,
    `${BRAND.tools.namespace}_watch_delegates`,
    'mcp__old-brand__WatchDelegates',
    'old-brand_watch_delegates',
  ])('keeps %s app plumbing without a live offer', (name) => {
    expect(
      CANOPY_INJECTED_TOOL_ENTRIES.map((tool) => tool.canonicalKey),
    ).not.toContain('watch_delegates');
    expect(getToolCategory(name)).toBe('canopy');
  });
});
