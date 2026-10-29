import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolvePipelineModelAlias } from '@canopy/pipeline-interop/normalize-pipeline';
import { discoverReviewTracks, parseReviewTrack } from '../logic';
import {
  expandStaticMatrix,
  resolveMatrixDefinition,
} from '../../../pipelines/matrix';

const document = (
  metadata: string,
  body = 'Review transaction atomicity.',
): string => `---\n${metadata}\n---\n${body}`;

describe('custom review track discovery', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'review-tracks-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('discovers sorted Markdown tracks and expands multiple models using the engine matrix', async () => {
    const directory = join(root, '.canopy/review-tracks');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'b.md'), document('model: $fast'));
    await writeFile(
      join(directory, 'a.md'),
      document(
        'name: Transactions\nmodels: [$default-codex, claude-opus-4-6]\nthinking_effort: xhigh\nfast_mode: false\nmax_turns: 12',
      ),
    );
    await writeFile(join(directory, 'ignored.txt'), 'not a track');
    await mkdir(join(directory, 'nested'));
    await writeFile(
      join(directory, 'nested/ignored.md'),
      'not recursively discovered',
    );
    const matrix = await discoverReviewTracks(root, '.canopy/review-tracks');
    const variants = expandStaticMatrix('custom_review_tracks', {
      matrix: resolveMatrixDefinition('custom_review_tracks', matrix),
      dynamic: false,
    });
    expect(variants).toHaveLength(3);
    expect(variants.map((variant) => variant.model)).toEqual([
      '$default-codex',
      'claude-opus-4-6',
      '$fast',
    ]);
    expect(new Set(variants.map((variant) => variant.id)).size).toBe(3);
    expect(variants[0]).toMatchObject({
      name: 'Transactions',
      thinking_effort: 'xhigh',
      fast_mode: 'false',
      max_turns: '12',
      prompt: 'Review transaction atomicity.',
    });
  });

  it.skip("accepts this repository's own review tracks with known model aliases", async () => {
    const repositoryRoot = resolve(__dirname, '../../../../../..');
    const { include } = await discoverReviewTracks(
      repositoryRoot,
      '.canopy/review-tracks',
    );
    expect(include.map((track) => track.file.split('\\').join('/'))).toEqual([
      '.canopy/review-tracks/lifecycle-contracts.md',
      '.canopy/review-tracks/test-evidence.md',
    ]);
    for (const track of include) {
      expect(() => resolvePipelineModelAlias(track.model)).not.toThrow();
      // Each track exits early when the diff touches none of its surfaces.
      expect(track.prompt.replace(/\s+/g, ' ')).toContain(
        'confirm that and return no issues',
      );
    }
  });

  it('returns an empty matrix for missing and empty directories', async () => {
    expect(await discoverReviewTracks(root, '.canopy/review-tracks')).toEqual({
      include: [],
    });
    await mkdir(join(root, '.canopy/review-tracks'), { recursive: true });
    const matrix = await discoverReviewTracks(root, '.canopy/review-tracks');
    expect(
      expandStaticMatrix('custom', {
        matrix: resolveMatrixDefinition('custom', matrix),
        dynamic: false,
      }),
    ).toEqual([]);
  });

  it('rejects invalid files atomically and includes their path in the error', async () => {
    await mkdir(join(root, '.canopy/review-tracks'), { recursive: true });
    await writeFile(
      join(root, '.canopy/review-tracks/a.md'),
      document('model: $fast'),
    );
    await writeFile(
      join(root, '.canopy/review-tracks/b.md'),
      document('models: nope'),
    );
    await expect(
      discoverReviewTracks(root, '.canopy/review-tracks'),
    ).rejects.toThrow('b.md:');
  });

  it('rejects symlink tracks and directories that escape the repository', async () => {
    await mkdir(join(root, '.canopy/review-tracks'), { recursive: true });
    await writeFile(join(root, 'prompt.md'), document('model: $fast'));
    await symlink(
      join(root, 'prompt.md'),
      join(root, '.canopy/review-tracks/link.md'),
    );
    await expect(
      discoverReviewTracks(root, '.canopy/review-tracks'),
    ).rejects.toThrow('regular Markdown files');
    await expect(discoverReviewTracks(root, '../')).rejects.toThrow(
      'inside the reviewed repository',
    );
  });

  it('rejects more variants than the engine can execute', async () => {
    await mkdir(join(root, '.canopy/review-tracks'), { recursive: true });
    await writeFile(
      join(root, '.canopy/review-tracks/a.md'),
      document(`models: ${JSON.stringify(Array(257).fill('$fast'))}`),
    );
    await expect(
      discoverReviewTracks(root, '.canopy/review-tracks'),
    ).rejects.toThrow('256 matrix variants');
  });

  it('preserves literal Markdown including expression-like text, quotes and line breaks', () => {
    const body = 'Review `x` and ${\u007b env.SECRET }}.\nQuotes: "hello"; $()';
    expect(
      parseReviewTrack(document('model: $fast', body), 'a.md').prompt,
    ).toBe(body);
    expect(
      parseReviewTrack(
        '\uFEFF' + document('model: $fast').split('\n').join('\r\n'),
        'a.md',
      ).models,
    ).toEqual(['$fast']);
  });

  it.each([
    ['model: [oops]', 'model must'],
    ['models: []', 'non-empty array'],
    ['models: [ok, 42]', 'non-empty array'],
    ['model: ok\nmodels: [ok]', 'exactly one'],
    ['name: Missing models', 'exactly one'],
    ['model: ok\nmodel: duplicate', 'Invalid YAML'],
    ['models: [', 'Invalid YAML'],
    ['- model', 'mapping'],
    ['model: agent_model_raw', 'pipeline aliases'],
    [
      'model: ok\npermission_preset: dangerous_all',
      'Unsupported reviewer argument',
    ],
    ['model: ok\nprompt_file: other.md', 'Unsupported reviewer argument'],
    [
      'model: ok\nstructured_output_schema: {}',
      'Unsupported reviewer argument',
    ],
    ['model: ok\nunknown: true', 'Unsupported reviewer argument'],
    ['model: ok\nthinking_effort: extreme', 'thinking_effort'],
    ['model: ok\nthinking_effort: ultra', 'thinking_effort'],
    ['model: ok\nthinking_effort: 3', 'thinking_effort'],
    ['model: ok\nfast_mode: "false"', 'boolean'],
    ['model: ok\nmax_turns: 0', 'positive safe integer'],
    ['model: ok\nmax_turns: 1.5', 'positive safe integer'],
    ['model: ok\nname: []', 'name must'],
  ])('rejects malformed/unsupported metadata: %s', (metadata, expected) => {
    expect(() => parseReviewTrack(document(metadata), 'track.md')).toThrow(
      expected,
    );
  });

  it('rejects missing/unterminated front matter and empty prompts', () => {
    for (const content of [
      'Prompt only',
      '---\nmodel: ok',
      document('model: ok', ' '),
    ]) {
      expect(() => parseReviewTrack(content, 'track.md')).toThrow('track.md:');
    }
  });
});
