import {
  isShareTargetKey,
  shareTargetKey,
  shareTargetFromEnableRef,
  SKILL_SHARE_NUDGE_USE_THRESHOLD,
} from '../skill-share-nudge';
import { sharingOpenDialogSchema } from '../sharing-action-schema';

describe('skill share contracts', () => {
  it('encodes complete identity without delimiter collisions', () => {
    const a = shareTargetKey({ kind: 'skill', sourceId: 'a:b', name: 'c/d' });
    const b = shareTargetKey({ kind: 'skill', sourceId: 'a', name: 'b:c/d' });
    expect(a).not.toBe(b);
    expect(isShareTargetKey(a)).toBe(true);
    expect(isShareTargetKey('skill:a:b')).toBe(false);
    expect(isShareTargetKey('["unknown","a","b"]')).toBe(false);
    expect(isShareTargetKey('["skill","",1]')).toBe(false);
    expect(isShareTargetKey(' ["skill","a","b"]')).toBe(false);
    expect(
      shareTargetKey({
        kind: 'plugin',
        marketplaceId: 'a:b',
        pluginName: 'c/d',
      }),
    ).not.toBe(a);
    expect(SKILL_SHARE_NUDGE_USE_THRESHOLD).toBe(3);
  });
  it('maps installed refs, aggregating all members of a plugin', () => {
    expect(
      shareTargetFromEnableRef({
        kind: 'skill',
        sourceId: 'custom:app',
        skillName: 'name',
      }),
    ).toEqual({ kind: 'skill', sourceId: 'custom:app', name: 'name' });
    expect(
      shareTargetFromEnableRef({
        kind: 'plugin',
        marketplaceId: 'market',
        pluginName: 'plugin',
      }),
    ).toEqual({
      kind: 'plugin',
      marketplaceId: 'market',
      pluginName: 'plugin',
    });
  });
  it('validates the shared action schema without accepting incomplete targets', () => {
    expect(
      sharingOpenDialogSchema.safeParse({
        type: 'sharing.open_dialog',
        target: { kind: 'skill', name: 'mine' },
      }).success,
    ).toBe(true);
    expect(
      sharingOpenDialogSchema.safeParse({
        type: 'sharing.open_dialog',
        target: { kind: 'plugin', marketplaceId: 'market', pluginName: 'mine' },
      }).success,
    ).toBe(true);
    for (const target of [
      { kind: 'skill', name: '' },
      { kind: 'plugin', pluginName: 'mine' },
      { kind: 'skill', name: 'mine', sourceId: 1 },
    ]) {
      expect(
        sharingOpenDialogSchema.safeParse({
          type: 'sharing.open_dialog',
          target,
        }).success,
      ).toBe(false);
    }
  });
});

describe('pipeline sharing action contract', () => {
  it.each([
    { kind: 'pipeline', source: 'stored', pipelineId: 'saved' },
    {
      kind: 'pipeline',
      source: 'project',
      pipelineId: 'project--ci.yaml',
      projectId: 'p',
      worktreeId: 'w',
      relativePath: '.canopy/pipelines/ci.yaml',
    },
  ])('accepts an exact pipeline locator %p', (target) => {
    expect(
      sharingOpenDialogSchema.safeParse({ type: 'sharing.open_dialog', target })
        .success,
    ).toBe(true);
  });
  it.each([
    { kind: 'pipeline', source: 'stored' },
    { kind: 'pipeline', source: 'stored', pipelineId: 'p', worktreeId: 'w' },
    {
      kind: 'pipeline',
      source: 'project',
      pipelineId: 'p',
      projectId: 'p',
      worktreeId: 'w',
      relativePath: '../escape.yaml',
    },
  ])('rejects incomplete or mixed pipeline locators %p', (target) => {
    expect(
      sharingOpenDialogSchema.safeParse({ type: 'sharing.open_dialog', target })
        .success,
    ).toBe(false);
  });
});
