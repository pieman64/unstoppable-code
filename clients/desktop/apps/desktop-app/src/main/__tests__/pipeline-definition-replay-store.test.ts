import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPipelineDefinitionReplayStore } from '../pipelines/pipeline-definition-replay-store';

const digest = (char: string): string => char.repeat(64);

describe('pipeline definition replay store', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'replay-store-'));
    file = join(dir, 'pipeline-definition-replays.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a missing file as an empty ledger and keeps what it saves', async () => {
    const store = createPipelineDefinitionReplayStore(() => file);
    expect(await store.load()).toEqual({ entries: [], expired: [] });
    const ledger = {
      entries: [
        {
          operation: 'core.pipeline.definition.upsert' as const,
          key: digest('a'),
          fingerprint: digest('b'),
          receipt: {
            kind: 'definition' as const,
            definitionId: 'pipeline-1',
            revision: 2,
          },
        },
      ],
      expired: [
        {
          operation: 'core.pipeline.definition.delete' as const,
          key: digest('c'),
        },
      ],
    };
    await store.save(ledger);
    expect(
      await createPipelineDefinitionReplayStore(() => file).load(),
    ).toEqual(ledger);
  });

  it('creates its directory when it saves the first receipt', async () => {
    const nested = join(dir, 'fresh', 'profile', 'replays.json');
    const ledger = {
      entries: [],
      expired: [
        {
          operation: 'core.pipeline.definition.upsert' as const,
          key: digest('a'),
        },
      ],
    };
    await createPipelineDefinitionReplayStore(() => nested).save(ledger);
    expect(
      await createPipelineDefinitionReplayStore(() => nested).load(),
    ).toEqual(ledger);
  });

  it('keeps an unreadable ledger aside and starts empty', async () => {
    writeFileSync(file, '{ not json');
    const store = createPipelineDefinitionReplayStore(() => file);
    expect(await store.load()).toEqual({ entries: [], expired: [] });
    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe('{ not json');
  });
});
