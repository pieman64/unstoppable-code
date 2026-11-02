import {
  decodeW5CompositionOutcome,
  w5CombineOutcomeParser,
  w5ExistingCombineOutcomeParser,
  w5PromoteOutcomeParser,
  type W5OutcomeParser,
} from '../composition-outcome';
import { W5OutcomeDecodeError } from '../worktree-outcome';

// Desktop's w5-worktree-outcome-parity test compares these decoders against
// the zod schemas they replaced; this pins the projection and the contract.

const row = { id: 'wt', branchName: 'main', createdAt: '2026-10-01' };
const workspace = {
  id: 'ws',
  type: 'multi-repo',
  name: 'W',
  color: '#000',
  order: 0,
  repos: [{ id: 'r', name: 'repo' }],
  worktrees: [row],
};
const combine = {
  repoMappings: [{ destinationRepoId: 'r', repoName: 'repo' }],
  selectedRepoIdRewrites: { s: 'r' },
  sourceWorkspaceId: 'ws-0',
  sourceWorktreeId: 'wt-0',
  destinationWorkspaceId: 'ws',
  destinationWorktreeId: 'wt',
  destinationWorkspace: workspace,
  destinationWorktree: row,
  createdTemporaryWorkspace: false,
  reusedWorkspace: true,
  removedSourceWorktree: true,
};

function refusal(decode: () => unknown): W5OutcomeDecodeError {
  try {
    decode();
  } catch (error) {
    if (error instanceof W5OutcomeDecodeError) return error;
    throw error;
  }
  throw new Error('Expected a decode refusal');
}

describe('composition outcome parsers', () => {
  it('project a saved promotion in shape order without host fields', () => {
    const decoded = w5PromoteOutcomeParser.parse(
      JSON.parse(
        '{"worktrees":[],"repos":[{"repoPath":"/r","name":"repo","id":"r"}],"temporary":true,"order":1,"color":"#000","name":"W","type":"multi-repo","id":"ws","path":"/w"}',
      ),
    );
    expect(JSON.stringify(decoded)).toBe(
      '{"id":"ws","type":"multi-repo","name":"W","color":"#000","order":1,"temporary":true,"repos":[{"id":"r","name":"repo"}],"worktrees":[]}',
    );
  });

  it('decode both combine variants, each keeping only its own fields', () => {
    const joinedWorktree = {
      repoMappings: [],
      selectedRepoIdRewrites: {},
      workspaceId: 'ws-2',
      worktreeId: 'wt-2',
      checkoutPath: '/j',
    };
    const existing = { ...combine, sourceCheckoutPath: '/s', joinedWorktree };
    expect(w5CombineOutcomeParser.parse(existing)).toStrictEqual(combine);
    expect(w5ExistingCombineOutcomeParser.parse(existing)).toStrictEqual({
      ...combine,
      joinedWorktree: {
        repoMappings: [],
        selectedRepoIdRewrites: {},
        workspaceId: 'ws-2',
        worktreeId: 'wt-2',
      },
    });
    expect(
      refusal(() => w5ExistingCombineOutcomeParser.parse(combine)).path,
    ).toBe('joinedWorktree');
  });

  it.each<[string, () => unknown, string]>([
    [
      'a non-finite order',
      (): unknown =>
        w5PromoteOutcomeParser.parse({ ...workspace, order: Infinity }),
      'order',
    ],
    [
      'another workspace type',
      (): unknown =>
        w5PromoteOutcomeParser.parse({ ...workspace, type: 'single' }),
      'type',
    ],
    [
      'a nested worktree row',
      (): unknown =>
        w5CombineOutcomeParser.parse({
          ...combine,
          destinationWorkspace: { ...workspace, worktrees: [row, {}] },
        }),
      'destinationWorkspace.worktrees.1.id',
    ],
    [
      'a mapping without its repository name',
      (): unknown =>
        w5CombineOutcomeParser.parse({
          ...combine,
          repoMappings: [{ destinationRepoId: 'r' }],
        }),
      'repoMappings.0.repoName',
    ],
    [
      'a top-level array',
      (): unknown => w5CombineOutcomeParser.parse([combine]),
      '',
    ],
  ])('refuse %s and name its path', (_name, decode, path) => {
    expect(refusal(decode).path).toBe(path);
  });
});

describe('decodeW5CompositionOutcome', () => {
  it('parses, round-trips through JSON and parses again with a caller parser', () => {
    const inputs: unknown[] = [];
    // A consumer decoder with a transform and a passthrough field.
    const parser: W5OutcomeParser<{ at: string; extra?: unknown }> = {
      parse: (outcome) => {
        inputs.push(outcome);
        if (typeof outcome !== 'object' || outcome === null)
          throw new Error('refused');
        const at: unknown = Reflect.get(outcome, 'at');
        return {
          ...outcome,
          at: at instanceof Date ? at.toISOString() : String(at),
        };
      },
    };
    const decoded = decodeW5CompositionOutcome(parser, {
      at: new Date(0),
      extra: { kept: true, dropped: undefined },
    });
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toStrictEqual({
      at: '1970-01-01T00:00:00.000Z',
      extra: { kept: true },
    });
    expect(decoded).toStrictEqual({
      at: '1970-01-01T00:00:00.000Z',
      extra: { kept: true },
    });
  });

  it('decodes a live result to the bytes its saved receipt replays', () => {
    const live = {
      ...combine,
      sourceRootRepoIdRewrite: undefined,
      destinationWorkspace: { ...workspace, collapsed: undefined },
    };
    const decoded = decodeW5CompositionOutcome(w5CombineOutcomeParser, live);
    const saved: unknown = JSON.parse(JSON.stringify(decoded));
    expect(decoded).toStrictEqual(
      decodeW5CompositionOutcome(w5CombineOutcomeParser, saved),
    );
    expect('sourceRootRepoIdRewrite' in decoded).toBe(false);
    expect('collapsed' in decoded.destinationWorkspace).toBe(false);
  });

  it('refuses through the first parse before serializing', () => {
    const parse = jest.fn((): never => {
      throw new Error('refused');
    });
    expect(() => decodeW5CompositionOutcome({ parse }, {})).toThrow('refused');
    expect(parse).toHaveBeenCalledTimes(1);
  });
});
