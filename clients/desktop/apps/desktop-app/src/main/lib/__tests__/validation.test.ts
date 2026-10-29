import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { assertWritableScope } from '../read-only-scope';
import {
  isMemoryReportId,
  validateMcpServerRefId,
  validatePipelineDefinitionLocator,
} from '../validation';

describe('validateMcpServerRefId', () => {
  it.each([
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    'linear',
    'custom:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    'account:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  ])('accepts %s', (id) => {
    expect(() => validateMcpServerRefId(id, 'serverId')).not.toThrow();
  });

  it.each([
    '',
    'Linear',
    'docs.v2',
    'docs_v2',
    '-docs',
    'custom:',
    'custom:ABC',
    'custom:../x',
    'custom:custom:abc',
    'account:',
    'account:ABC',
    'device:abc',
    ':abc',
    42,
    undefined,
  ])('rejects %p', (id) => {
    expect(() => validateMcpServerRefId(id, 'serverId')).toThrow(
      'Invalid serverId',
    );
  });
});

describe('assertWritableScope', () => {
  it('rejects the shared-container viewer and permits ordinary scopes', () => {
    expect(() =>
      assertWritableScope(SHARED_CONTAINER_VIEWER_PROJECT_ID),
    ).toThrow('read-only');
    expect(() => assertWritableScope('project-a')).not.toThrow();
  });
});

describe('validatePipelineDefinitionLocator', () => {
  it.each(['pipeline-1', 'build'])('accepts general definition id %s', (id) => {
    expect(() =>
      validatePipelineDefinitionLocator(id, 'pipelineId'),
    ).not.toThrow();
  });

  it.each(['_matrix-job', 'legacy_job', 'Build'])(
    'rejects runtime-only identifier %s for definition lookup',
    (id) => {
      expect(() => validatePipelineDefinitionLocator(id, 'pipelineId')).toThrow(
        'Invalid pipelineId: must be lowercase alphanumeric with hyphens',
      );
    },
  );

  it.each(['project--ci.yml', 'project--deploy/staging.yaml'])(
    'accepts namespaced pipeline filename %s',
    (id) => {
      expect(() =>
        validatePipelineDefinitionLocator(id, 'pipelineId'),
      ).not.toThrow();
    },
  );

  it.each([
    'project--My Pipelines/Deploy_Prod.yaml',
    'project--nested/UPPER-case.yml',
  ])('accepts discovered filename charset in pipeline path %s', (id) => {
    expect(() =>
      validatePipelineDefinitionLocator(id, 'pipelineId'),
    ).not.toThrow();
  });

  it.each([
    ['NUL', 'project--ci\u0000.yaml'],
    ['newline', 'project--ci\n.yaml'],
    ['DEL', 'project--dir\u007f/ci.yml'],
  ])('rejects %s control character in pipeline path', (_label, id) => {
    expect(() => validatePipelineDefinitionLocator(id, 'pipelineId')).toThrow(
      'Invalid pipelineId: must identify a YAML pipeline file',
    );
  });

  // CAN-3021: the portal plan picker can now offer a shared/cloud pipeline,
  // whose id is `shared:<serverId>:<remoteId>`. Before this the colons alone
  // failed the safe-ID charset and Run answered with an opaque error.
  it.each([
    'shared:canopy-cloud:abc123',
    'shared:canopy-cloud:01JD-7Z_x.9',
    `shared:canopy-cloud:${'a'.repeat(128)}`,
  ])('accepts shared cloud pipeline id %s', (id) => {
    expect(() =>
      validatePipelineDefinitionLocator(id, 'pipelineId'),
    ).not.toThrow();
  });

  it.each([
    ['unknown server', 'shared:evil-server:abc123'],
    ['missing remote id', 'shared:canopy-cloud:'],
    ['missing server id', 'shared::abc123'],
    ['extra segment', 'shared:canopy-cloud:abc:123'],
    ['no segments', 'shared:'],
    ['path traversal', 'shared:canopy-cloud:../../etc/passwd'],
    ['slash in remote id', 'shared:canopy-cloud:a/b'],
    ['control character', 'shared:canopy-cloud:abc\u0000'],
    ['leading dot', 'shared:canopy-cloud:.hidden'],
    ['over length', `shared:canopy-cloud:${'a'.repeat(129)}`],
  ])('rejects shared pipeline id with %s', (_label, id) => {
    expect(() => validatePipelineDefinitionLocator(id, 'pipelineId')).toThrow(
      'Invalid pipelineId: must identify a canopy-cloud shared pipeline',
    );
  });
});

describe('isMemoryReportId', () => {
  it.each([
    'report-20261021T162619Z',
    'auto-20261021T162619Z',
    'report-20261021T162619Z-12',
  ])('accepts %s', (id) => {
    expect(isMemoryReportId(id)).toBe(true);
  });

  it.each([
    17,
    '',
    'report-20261021t162619z',
    'report-20261021T162619Z-0',
    'unknown-20261021T162619Z',
    '../report-20261021T162619Z',
    'report-20261021T162619Z/..',
    `report-20261021T162619Z-${'1'.repeat(7)}`,
  ])('rejects %p', (id) => {
    expect(isMemoryReportId(id)).toBe(false);
  });
});
