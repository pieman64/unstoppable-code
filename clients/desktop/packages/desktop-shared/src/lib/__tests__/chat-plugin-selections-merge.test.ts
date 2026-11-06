import {
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  type ChatTabPluginSelections,
} from '../../types';
import { mergeDeferredToolsReloadAdditions } from '../chat-plugin-selections-merge';
import { PIPELINE_EDITOR_REQUIRED_SKILL_REF } from '../pipeline-editor-tools';

const target = { projectId: 'project-1', worktreeId: 'worktree-1' };

describe('reload selection merge (CAN-4127)', () => {
  it('merging reload additions keeps every existing selection and adds each new ref once', () => {
    const base: ChatTabPluginSelections = {
      collectionIds: ['collection-1'],
      skillRefs: [
        { sourceId: 'local', skillName: 'one' },
        { sourceId: 'local', skillName: 'two' },
      ],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'first' }],
      mcpServerRefs: [{ serverId: 'server', configId: 'config' }],
      mcpHttpAuthPreferences: [
        {
          target: {
            kind: 'standalone',
            serverId: 'server',
            configId: 'config',
          },
          handler: 'provider',
        },
      ],
    };

    const merged = mergeDeferredToolsReloadAdditions(
      base,
      {
        skillRefs: [{ sourceId: 'local', skillName: 'two' }],
        pluginRefs: [{ marketplaceId: 'demo/market', pluginName: 'x' }],
        mcpServerRefs: [{ serverId: 'org-server', configId: 'cfg/a' }],
      },
      target,
    );

    expect(merged).toEqual({
      collectionIds: ['collection-1'],
      skillRefs: [
        { sourceId: 'local', skillName: 'one' },
        { sourceId: 'local', skillName: 'two' },
      ],
      pluginRefs: [
        { marketplaceId: 'market', pluginName: 'first' },
        { marketplaceId: 'demo/market', pluginName: 'x' },
      ],
      mcpServerRefs: [
        { serverId: 'server', configId: 'config' },
        { serverId: 'org-server', configId: 'cfg/a' },
      ],
      mcpHttpAuthPreferences: base.mcpHttpAuthPreferences,
    });
  });

  it('a pipeline editor chat keeps its required skill', () => {
    const pipelineEditor = {
      projectId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
    };
    const additions = {
      skillRefs: [{ sourceId: 'local', skillName: 'extra' }],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const isRequired = (ref: {
      sourceId: string;
      skillName: string;
    }): boolean =>
      ref.sourceId === PIPELINE_EDITOR_REQUIRED_SKILL_REF.sourceId &&
      ref.skillName === PIPELINE_EDITOR_REQUIRED_SKILL_REF.skillName;

    for (const base of [
      undefined,
      {
        collectionIds: [],
        skillRefs: [{ ...PIPELINE_EDITOR_REQUIRED_SKILL_REF }],
        pluginRefs: [],
      },
    ]) {
      const merged = mergeDeferredToolsReloadAdditions(
        base,
        additions,
        pipelineEditor,
      );
      expect(merged.skillRefs.filter(isRequired)).toHaveLength(1);
      expect(merged.skillRefs).toContainEqual({
        sourceId: 'local',
        skillName: 'extra',
      });
    }
  });
});
