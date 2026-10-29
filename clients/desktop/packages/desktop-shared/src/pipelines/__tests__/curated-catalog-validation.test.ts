import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  validateCuratedPipeline,
  PipelineCatalogValidationError,
} from '@canopy/pipeline-interop/catalog-validation';
import { normalizePipeline } from '@canopy/pipeline-interop/normalize-pipeline';
import { parsePipelineText } from '@canopy/pipeline-interop/parse-pipeline';
import { getTriggerTypes } from '@canopy/pipeline-interop/document';
import type { PipelineCatalogIssue } from '@canopy/protocol/pipeline-catalog';
import type { PipelinePackageManifestV1 } from '@canopy/protocol/pipelines';
const valid =
  'name: Test\non: dispatch\njobs:\n  build:\n    steps:\n      - run: echo hello\n';
function issues(text: string): PipelineCatalogIssue[] {
  try {
    validateCuratedPipeline(text);
    throw new Error('Expected validation failure');
  } catch (error) {
    if (error instanceof PipelineCatalogValidationError) return error.issues;
    throw error;
  }
}
describe('curated publication validation', () => {
  it('extracts bounded metadata without transporting jobs or inputs', () => {
    expect(validateCuratedPipeline(valid)).toEqual({
      name: 'Test',
      shortDescription: '',
      icon: '',
      version: '',
      triggerTypes: ['dispatch'],
      scopes: ['directory'],
      jobCount: 1,
      stepCount: 1,
      contentSizeBytes: Buffer.byteLength(valid),
    });
  });
  it('counts UTF-8 bytes and bounds before YAML parsing', () => {
    expect(issues('é'.repeat(600000))[0]).toMatchObject({
      path: 'rawPipeline',
      code: 'too_large',
    });
  });
  it('reports YAML coordinates without excerpts', () => {
    const text = valid + 'broken: [PRIVATE_SECRET';
    const result = issues(text);
    expect(result[0]).toMatchObject({
      path: 'rawPipeline',
      code: 'invalid_yaml',
      line: 8,
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SECRET');
  });
  it.each(['foo: bar', 'pipeline:\n  foo: bar'])(
    'rejects documents without the required pipeline shape: %s',
    (text) => expect(() => parsePipelineText(text)).toThrow('name'),
  );
  it.each([
    'name: Test\non: dispatch\njobs: []',
    'name: Test\non: dispatch\njobs: {}',
  ])('rejects malformed jobs %s', (text) =>
    expect(issues(text)[0].path).toBe('jobs'),
  );
  it('rejects empty steps and invalid run/uses at exact paths', () => {
    expect(issues(valid.replace('run: echo hello', 'run: ""'))[0].path).toBe(
      'jobs.build.steps.0',
    );
  });
  it('rejects local action references', () => {
    expect(
      issues(valid.replace('run: echo hello', 'uses: ./actions/private'))[0],
    ).toMatchObject({
      path: 'jobs.build.steps.0.uses',
      code: 'unsupported_reference',
    });
  });
  it('rejects nonportable child references', () => {
    expect(
      issues(valid.replace('run: echo hello', 'uses: builtin/run-pipeline'))[0]
        .code,
    ).toBe('unsupported_reference');
  });
  it.each([
    {
      uses: 'project/review',
      kind: 'pipeline_action' as const,
      invocationKey: 'project/review',
      withBlock: '',
    },
    {
      uses: 'builtin/run-pipeline',
      kind: 'child_pipeline' as const,
      invocationKey: 'children/review.yaml',
      withBlock: '\n        with:\n          pipeline: children/review.yaml',
    },
  ])(
    'accepts $kind only when it is bound to the exact step',
    ({ uses, kind, invocationKey, withBlock }) => {
      const raw = valid.replace('run: echo hello', `uses: ${uses}${withBlock}`);
      const manifest: PipelinePackageManifestV1 = {
        version: 1,
        pipelineContentHash: '0'.repeat(64),
        resources: [
          {
            id: 'portable-resource',
            kind,
            displayName: invocationKey,
            sourceLabel: invocationKey,
            sourceVisibility: 'local',
            invocationKeys: [invocationKey],
            dependencyResourceIds: [],
            trees: [],
          },
        ],
        bindings: [
          {
            jobId: 'build',
            stepId: '__auto_step_0',
            resourceIds: ['portable-resource'],
          },
        ],
        environmentRequirements: [],
        totalFiles: 0,
        totalBytes: 0,
      };
      expect(() =>
        validateCuratedPipeline(raw, { packageManifest: manifest }),
      ).not.toThrow();
      manifest.bindings = [
        { jobId: 'build', stepId: 'other', resourceIds: ['portable-resource'] },
      ];
      expect(() =>
        validateCuratedPipeline(raw, { packageManifest: manifest }),
      ).toThrow(PipelineCatalogValidationError);
    },
  );
  it('uses existing semantic cycle validation', () => {
    const result = issues(
      valid.replace('    steps:', '    needs: build\n    steps:'),
    );
    expect(result[0].code).toBe('invalid_pipeline');
  });
  it('uses existing missing needs validation', () => {
    expect(
      issues(valid.replace('    steps:', '    needs: missing\n    steps:'))[0]
        .code,
    ).toBe('invalid_pipeline');
  });
  it('rejects unsupported triggers', () =>
    expect(issues(valid.replace('on: dispatch', 'on: cron'))[0].path).toBe(
      'on',
    ));
  it('rejects aliases before normalization', () =>
    expect(
      issues('name: Test\non: dispatch\njobs: &jobs\n  cyclic: *jobs')[0].code,
    ).toBe('yaml_alias'));
  it('rejects scalar aliases before js-yaml resolves them', () =>
    expect(
      issues(
        'name: &pipeline_name Test\ndescription: *pipeline_name\non: dispatch\njobs:\n  build:\n    steps:\n      - run: echo hello\n',
      )[0].code,
    ).toBe('yaml_alias'));
  it('bounds descriptions and flattens whitespace', () =>
    expect(
      validateCuratedPipeline(valid + 'description: ' + 'a'.repeat(1000))
        .shortDescription,
    ).toHaveLength(256));
  it.each(['code-review-claude.yaml', 'code-review-codex.yaml'])(
    'matches real bundled pipeline metadata %s',
    (filename) => {
      const raw = readFileSync(
        resolve(__dirname, '../../../resources/pipelines', filename),
        'utf8',
      ).replace(/\{\{BRAND_REPORT_ACTION_ID\}\}/g, 'report');
      const parsed = parsePipelineText(raw),
        normalized = normalizePipeline(parsed);
      const result = validateCuratedPipeline(raw);
      expect(result).toMatchObject({
        name: parsed.name,
        triggerTypes: getTriggerTypes(parsed.on),
        scopes: normalized.scope,
        jobCount: Object.keys(parsed.jobs).length,
      });
    },
  );
});

it('does not echo multiline identifiers or source values in semantic diagnostics', () => {
  for (const raw of [
    valid.replace('  build:', '  "PRIVATE_SECRET\\nMORE_SECRET":'),
    valid.replace(
      '    steps:',
      '    needs: "PRIVATE_SECRET\\nMORE_SECRET"\n    steps:',
    ),
    valid.replace(
      '      - run:',
      '      - id: "PRIVATE_SECRET\\nMORE_SECRET"\n        run:',
    ),
    valid + 'scope: "PRIVATE_SECRET\\nMORE_SECRET"\n',
  ]) {
    const diagnostic = issues(raw);
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /PRIVATE_SECRET|MORE_SECRET/,
    );
    expect(diagnostic[0].message).toBeTruthy();
  }
});
