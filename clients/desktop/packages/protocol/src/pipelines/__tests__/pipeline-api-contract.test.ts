import {
  API_PIPELINE_TRIGGER_TYPES,
  pipelineSharePath,
  PIPELINE_SHARE_SCOPES,
  type PipelineApiDetail,
  type PipelineApiUpdateRequest,
  type PublishSharedPipelinePublicShareResponse,
  type SharedPipelineDetail,
} from '../index';

describe('pipeline protocol contract', () => {
  it('pins wire trigger types and share scopes', () => {
    expect(API_PIPELINE_TRIGGER_TYPES).toEqual([
      'dispatch',
      'plan_ready',
      'task_ready',
    ]);
    expect(PIPELINE_SHARE_SCOPES).toEqual(['private', 'team', 'organization']);
  });

  it('keeps server and desktop shared detail shapes assignable', () => {
    const detail: PipelineApiDetail = {
      id: 'pipe-1',
      name: 'Pipeline',
      description: '',
      icon: 'P',
      version: '1.0',
      triggerTypes: ['dispatch'],
      createdBy: { id: 'user-1', name: 'User' },
      shareScope: 'private',
      owner: { type: 'user', id: 'user-1', name: 'User' },
      createdAt: '2026-05-11T00:00:00.000Z',
      updatedAt: '2026-05-11T00:00:00.000Z',
      canUpdate: true,
      canDelete: true,
      rawPipeline: 'name: Pipeline',
      contentHash: 'hash-1',
    };

    const shared: SharedPipelineDetail = detail;
    expect(shared.owner?.type).toBe('user');
  });

  it('carries conditional-update and audience fields on pipeline updates', () => {
    const update: PipelineApiUpdateRequest = {
      rawPipeline: 'name: Pipeline',
      expectedContentHash: 'hash-1',
      shareScope: 'team',
      teamId: 'team-1',
    };

    expect(update).toMatchObject({
      expectedContentHash: 'hash-1',
      shareScope: 'team',
      teamId: 'team-1',
    });
  });

  it('builds canonical public pipeline share paths and contracts', () => {
    const publicShare = {
      externalId: 'share-1',
      pinnedContentHash: 'hash-1',
      upToDate: true,
      sharePath: '/portal/plugins/pipelines/shared/pipe-1',
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
    };
    const response: PublishSharedPipelinePublicShareResponse = { publicShare };

    expect(pipelineSharePath('pipe-1')).toBe(
      '/portal/plugins/pipelines/shared/pipe-1',
    );
    expect(response.publicShare).toEqual(publicShare);
  });
});
