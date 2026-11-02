import {
  declaredPipelineAssetIds,
  findPipelineAssetReferences,
  normalizePipelineAssets,
  validatePipelineAssetDeclarations,
} from '../assets';
import { normalizePipeline } from '../normalize-pipeline';
import { parsePipelineText } from '../parse-pipeline';

function textContaining(text: string): unknown {
  return expect.stringContaining(text);
}

const assetPipeline = `
name: Entry
on: dispatch
assets:
  - id: specialists
    path: ~/.canopy/journey-specialists/specialists
    description: Specialist configs
  - id: notes
    path: ~/notes
    required: false
    install: replace
local_state:
  - ~/.canopy/journey-specialists/state.db
jobs:
  run:
    steps:
      - run: ls "\${{ assets.specialists.path }}"
`;

describe('pipeline asset declarations', () => {
  it('normalizes assets with defaults and carries local_state', () => {
    const normalized = normalizePipeline(parsePipelineText(assetPipeline));
    expect(normalized.assets).toEqual([
      {
        id: 'specialists',
        path: '~/.canopy/journey-specialists/specialists',
        description: 'Specialist configs',
        required: true,
        install: 'seed',
      },
      {
        id: 'notes',
        path: '~/notes',
        required: false,
        install: 'replace',
      },
    ]);
    expect(normalized.local_state).toEqual([
      '~/.canopy/journey-specialists/state.db',
    ]);
  });

  it('omits both keys for a pipeline that declares neither', () => {
    const normalized = normalizePipeline(
      parsePipelineText(
        'name: Plain\non: dispatch\njobs:\n  a:\n    steps:\n      - run: echo\n',
      ),
    );
    expect(normalized).not.toHaveProperty('assets');
    expect(normalized).not.toHaveProperty('local_state');
  });

  it.each([
    [[{ id: 'Bad-Id', path: '~/x' }], 'assets[0].id', 'Invalid asset id'],
    [[{ id: '1abc', path: '~/x' }], 'assets[0].id', 'Invalid asset id'],
    [[{ id: `a${'b'.repeat(32)}`, path: '~/x' }], 'assets[0].id', 'Invalid'],
    [[{ path: '~/x' }], 'assets[0].id', 'id is required'],
    [
      [
        { id: 'a', path: '~/x' },
        { id: 'a', path: '~/y' },
      ],
      'assets[1].id',
      'Duplicate asset id "a"',
    ],
    [[{ id: 'a', path: 'x', install: 'merge' }], 'assets[0].install', 'seed'],
    [[{ id: 'a' }], 'assets[0].path', 'path is required'],
    [[{ id: 'a', path: 42 }], 'assets[0].path', 'path is required'],
    [[{ id: 'a', path: '~/x', required: 'yes' }], 'assets[0].required', ''],
    [[{ id: 'a', path: '~/x', description: 3 }], 'assets[0].description', ''],
    ['specialists', 'assets', 'list'],
    [['specialists'], 'assets[0]', 'object'],
  ])('rejects assets %j', (assets, issuePath, message) => {
    const issues = validatePipelineAssetDeclarations({ assets });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: issuePath,
          message: textContaining(message),
        }),
      ]),
    );
    expect(() => normalizePipelineAssets(assets)).toThrow();
  });

  it.each([[['~/ok', 3]], [['']], ['~/state.db']])(
    'rejects local_state %j',
    (localState) => {
      expect(
        validatePipelineAssetDeclarations({ local_state: localState }),
      ).not.toEqual([]);
    },
  );

  it('fails normalization for a malformed declaration', () => {
    expect(() =>
      normalizePipeline(
        parsePipelineText(
          'name: Bad\non: dispatch\nassets:\n  - id: a\n    path: ~/a\n  - id: a\n    path: ~/b\njobs:\n  a:\n    steps:\n      - run: echo\n',
        ),
      ),
    ).toThrow('Duplicate asset id "a"');
    expect(() =>
      normalizePipeline(
        parsePipelineText(
          'name: Bad\non: dispatch\nlocal_state:\n  - 4\njobs:\n  a:\n    steps:\n      - run: echo\n',
        ),
      ),
    ).toThrow('local_state');
  });
});

describe('asset expression references', () => {
  it('finds asset roots in every string of the document', () => {
    expect(
      findPipelineAssetReferences({
        env: { DIR: '${{ assets.specialists.path }}' },
        jobs: {
          a: {
            steps: [
              { run: 'cat ${{assets.notes.path}}/x ${{ assets.notes.path }}' },
              { with: { prompt: 'Use ${{ format(assets.extra.path) }}' } },
            ],
          },
        },
      }).sort(),
    ).toEqual(['extra', 'notes', 'specialists']);
  });

  it('ignores assets outside expressions and as another root property', () => {
    expect(
      findPipelineAssetReferences([
        'assets.loose.path',
        '${{ steps.assets.outputs.path }}',
        '${{ env.assets.path }}',
        '${{ needs.x.outputs.assets }}',
      ]),
    ).toEqual([]);
  });

  it('collects declared ids', () => {
    expect(
      Array.from(
        declaredPipelineAssetIds([{ id: 'a', path: '~' }, { path: '~' }, 'x']),
      ),
    ).toEqual(['a']);
  });
});
