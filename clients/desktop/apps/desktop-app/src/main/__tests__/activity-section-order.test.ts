import type { ActivitySectionId } from '@canopy/desktop-shared/types';
import {
  DEFAULT_ACTIVITY_SECTION_ORDER,
  resolveActivitySectionOrder,
} from '@canopy/desktop-shared/constants/activity';

describe('resolveActivitySectionOrder', () => {
  it('places Cost immediately after pipeline runs by default', () => {
    expect(DEFAULT_ACTIVITY_SECTION_ORDER.indexOf('cost')).toBe(
      DEFAULT_ACTIVITY_SECTION_ORDER.indexOf('pipeline-runs') + 1,
    );
  });

  it('returns default order when persisted is undefined', () => {
    const result = resolveActivitySectionOrder(undefined);
    expect(result).toEqual(DEFAULT_ACTIVITY_SECTION_ORDER);
  });

  it('returns default order when persisted is empty', () => {
    const result = resolveActivitySectionOrder([]);
    expect(result).toEqual(DEFAULT_ACTIVITY_SECTION_ORDER);
  });

  it('returns a copy, not a reference to the default array', () => {
    const result = resolveActivitySectionOrder(undefined);
    expect(result).not.toBe(DEFAULT_ACTIVITY_SECTION_ORDER);
  });

  it('preserves a valid custom order', () => {
    const custom: ActivitySectionId[] = [
      'summary',
      'todo',
      'scripts',
      'hooks',
      'pipeline-runs',
      'cost',
      'background-processes',
      'pull-request',
      'changed-files',
      'plans',
      'mcp-servers',
      'plugins',
      'terminals',
      'memory',
      'notes',
      'prompts',
      'attachments',
    ];
    const result = resolveActivitySectionOrder(custom);
    expect(result).toEqual(custom);
  });

  it('preserves the web terminals id in its persisted position', () => {
    const result = resolveActivitySectionOrder([
      'scripts',
      'terminals',
      'summary',
    ]);

    expect(result.slice(0, 3)).toEqual(['scripts', 'terminals', 'summary']);
  });

  it('filters out stale IDs not in the default set', () => {
    const withStale: ActivitySectionId[] = [
      'summary',
      'todo',
      'nonexistent-section' as ActivitySectionId,
      'changed-files',
      'pull-request',
      'background-processes',
      'pipeline-runs',
      'scripts',
    ];
    const result = resolveActivitySectionOrder(withStale);
    expect(result).not.toContain('nonexistent-section');
    expect(result).toHaveLength(DEFAULT_ACTIVITY_SECTION_ORDER.length);
  });

  it('de-duplicates persisted IDs while preserving order', () => {
    const withDupes: ActivitySectionId[] = [
      'summary',
      'todo',
      'changed-files',
      'todo',
      'scripts',
      'changed-files',
      'pull-request',
      'background-processes',
      'pipeline-runs',
      'cost',
      'plans',
    ];
    const result = resolveActivitySectionOrder(withDupes);
    expect(result).toEqual([
      'summary',
      'todo',
      'changed-files',
      'scripts',
      'pull-request',
      'background-processes',
      'pipeline-runs',
      'cost',
      'plans',
      'mcp-servers',
      'plugins',
      'hooks',
      'terminals',
      'memory',
      'notes',
      'prompts',
      'attachments',
    ]);
  });

  it('appends new default IDs missing from persisted order', () => {
    const partial: ActivitySectionId[] = ['todo', 'changed-files'];
    const result = resolveActivitySectionOrder(partial);
    expect(result[0]).toBe('todo');
    expect(result[1]).toBe('changed-files');
    expect(result).toHaveLength(DEFAULT_ACTIVITY_SECTION_ORDER.length);
    expect(result).toContain('summary');
    for (const id of DEFAULT_ACTIVITY_SECTION_ORDER) {
      expect(result).toContain(id);
    }
  });

  it('inserts Cost after pipeline runs when resolving a pre-Cost saved order', () => {
    const result = resolveActivitySectionOrder([
      'summary',
      'pipeline-runs',
      'scripts',
    ]);

    expect(result.indexOf('cost')).toBe(result.indexOf('pipeline-runs') + 1);
  });
});
