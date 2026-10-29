import { collectPipelineCapabilityRefs } from '../plugin-collections';
import type { Pipeline, PipelinePluginCollection } from '../../types/pipeline';

function pipelineWith(
  collections: PipelinePluginCollection[] | undefined,
): Pick<Pipeline, 'plugin_collections'> {
  return { plugin_collections: collections };
}

describe('collectPipelineCapabilityRefs', () => {
  it('returns an empty list when no collections are declared', () => {
    expect(collectPipelineCapabilityRefs(pipelineWith(undefined))).toEqual([]);
    expect(collectPipelineCapabilityRefs(pipelineWith([]))).toEqual([]);
  });

  it('collects skill and plugin refs with collection attribution', () => {
    const refs = collectPipelineCapabilityRefs(
      pipelineWith([
        {
          id: 'review_tools',
          name: 'Review Tools',
          defaults: [
            {
              type: 'skill',
              source: { type: 'builtin', id: 'app' },
              skill_name: 'code-review-checklist',
              required: true,
            },
            {
              type: 'codex_plugin',
              marketplace: { type: 'codex-builtin', id: 'openai-curated' },
              plugin_name: 'codex-security',
            },
          ],
        },
      ]),
    );

    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({
      kind: 'skill',
      required: true,
      collectionId: 'review_tools',
      collectionName: 'Review Tools',
    });
    expect(refs[1]).toMatchObject({
      kind: 'plugin',
      required: false,
      collectionId: 'review_tools',
    });
    expect(refs[0].key).not.toEqual(refs[1].key);
  });

  it('deduplicates the same ref across collections, first collection wins', () => {
    const skillRef = {
      type: 'skill',
      source: { type: 'builtin', id: 'app' },
      skill_name: 'shared-skill',
    } as const;
    const refs = collectPipelineCapabilityRefs(
      pipelineWith([
        { id: 'first', name: 'First', defaults: [{ ...skillRef }] },
        { id: 'second', name: 'Second', defaults: [{ ...skillRef }] },
      ]),
    );

    expect(refs).toHaveLength(1);
    expect(refs[0].collectionId).toBe('first');
    expect(refs[0].required).toBe(false);
  });

  it('attributes an upgraded-to-required ref to the requiring collection', () => {
    const skillRef = {
      type: 'skill',
      source: { type: 'builtin', id: 'app' },
      skill_name: 'shared-skill',
    } as const;
    const refs = collectPipelineCapabilityRefs(
      pipelineWith([
        { id: 'first', name: 'First', defaults: [{ ...skillRef }] },
        {
          id: 'second',
          name: 'Second',
          defaults: [{ ...skillRef, required: true }],
        },
        // A later optional re-declaration must not steal attribution back.
        { id: 'third', name: 'Third', defaults: [{ ...skillRef }] },
      ]),
    );

    expect(refs).toHaveLength(1);
    expect(refs[0].required).toBe(true);
    // "Required by <collection>" must name the collection that requires it.
    expect(refs[0].collectionId).toBe('second');
    expect(refs[0].collectionName).toBe('Second');
  });

  it('treats github and claude_plugin refs as plugins with distinct keys', () => {
    const refs = collectPipelineCapabilityRefs(
      pipelineWith([
        {
          id: 'mixed',
          name: 'Mixed',
          defaults: [
            {
              type: 'claude_plugin',
              marketplace: { type: 'github', repo: 'acme/marketplace' },
              plugin_name: 'writer-toolkit',
            },
            {
              type: 'plugin',
              marketplace: { type: 'github', repo: 'acme/marketplace' },
              plugin_name: 'writer-toolkit',
            },
          ],
        },
      ]),
    );

    expect(refs).toHaveLength(2);
    expect(refs.every((ref) => ref.kind === 'plugin')).toBe(true);
    expect(new Set(refs.map((ref) => ref.key)).size).toBe(2);
  });
});
