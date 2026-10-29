import {
  PLUGIN_MENTION_KIND,
  buildPluginMentionAbsolutePath,
  collectMentionedPluginRefs,
  missingMentionedPluginRefs,
  parsePluginMentionAbsolutePath,
  partitionPluginMentions,
} from '../plugin-mention';

const figma = { marketplaceId: 'claude-plugins-official', pluginName: 'figma' };
const delta = { marketplaceId: 'demo/market', pluginName: 'delta-tool' };

function mention(ref: { marketplaceId: string; pluginName: string }): {
  displayPath: string;
  absolutePath: string;
  kind: string;
} {
  return {
    displayPath: ref.pluginName,
    absolutePath: buildPluginMentionAbsolutePath(ref),
    kind: PLUGIN_MENTION_KIND,
  };
}

describe('plugin mention locators', () => {
  it('round-trips ids that contain slashes', () => {
    const locator = buildPluginMentionAbsolutePath(delta);
    expect(locator).toBe('plugin://demo%2Fmarket/delta-tool');
    expect(parsePluginMentionAbsolutePath(locator)).toEqual(delta);
  });

  it('rejects filesystem paths and malformed locators', () => {
    expect(parsePluginMentionAbsolutePath('/repo/src/app.ts')).toBeNull();
    expect(parsePluginMentionAbsolutePath('plugin://')).toBeNull();
    expect(
      parsePluginMentionAbsolutePath('plugin://only-marketplace'),
    ).toBeNull();
    expect(parsePluginMentionAbsolutePath('plugin://%E0%A4%A/x')).toBeNull();
  });

  it('partitions plugin mentions away from file references in order', () => {
    const file = { displayPath: 'a.ts', absolutePath: '/repo/a.ts' };
    expect(
      partitionPluginMentions([mention(figma), file, mention(delta)]),
    ).toEqual({
      fileReferences: [file],
      pluginMentions: [mention(figma), mention(delta)],
    });
  });
});

describe('mentioned plugin enablement', () => {
  it('collects each mentioned plugin once, ignoring files and bad locators', () => {
    expect(
      collectMentionedPluginRefs([
        mention(figma),
        { displayPath: 'a.ts', absolutePath: '/repo/a.ts' },
        mention(figma),
        {
          displayPath: 'x',
          absolutePath: 'plugin://',
          kind: PLUGIN_MENTION_KIND,
        },
        mention(delta),
      ]),
    ).toEqual([figma, delta]);
  });

  it('keeps plugins apart whose ids only collide when joined with a slash', () => {
    const nested = { marketplaceId: 'demo', pluginName: 'market/delta-tool' };
    expect(
      collectMentionedPluginRefs([mention(delta), mention(nested)]),
    ).toEqual([delta, nested]);
    expect(missingMentionedPluginRefs([mention(nested)], [delta])).toEqual([
      nested,
    ]);
  });

  it('reports only the mentioned plugins the chat has not enabled', () => {
    expect(
      missingMentionedPluginRefs([mention(figma), mention(delta)], [figma]),
    ).toEqual([delta]);
    expect(missingMentionedPluginRefs([mention(figma)], [figma])).toEqual([]);
    expect(missingMentionedPluginRefs([], [])).toEqual([]);
  });
});
