import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPipelineJsonValue } from '../json-values';
import { parsePipelineText } from '../parse-pipeline';

describe('isPipelineJsonValue', () => {
  it('accepts shared acyclic object references', () => {
    const shared = { label: 'shared', values: [1, true, null] };

    expect(
      isPipelineJsonValue({
        first: shared,
        second: shared,
      }),
    ).toBe(true);
  });

  it('visits each unique node once in a deep YAML alias fan-out graph', () => {
    const raw: string = fs.readFileSync(
      path.join(
        process.cwd(),
        'packages/desktop-shared/src/pipelines/__tests__/fixtures/json-values-deep-alias-fanout.yaml',
      ),
      'utf8',
    );
    const pipeline = parsePipelineText(raw);
    const matrix = pipeline.jobs.validate?.strategy?.matrix;
    if (matrix === undefined || typeof matrix === 'string') {
      throw new Error('Expected the fixture matrix value to be an object');
    }
    const item = matrix.item;
    if (!Array.isArray(item)) {
      throw new Error('Expected the fixture matrix item axis to be an array');
    }

    let leaf: unknown = item;
    while (Array.isArray(leaf)) {
      leaf = leaf[0];
    }
    if (leaf === null || typeof leaf !== 'object') {
      throw new Error('Expected the fixture alias graph to end in an object');
    }

    let leafReads = 0;
    Object.defineProperty(leaf, 'value', {
      configurable: true,
      enumerable: true,
      get: (): string => {
        leafReads += 1;
        return 'leaf';
      },
    });

    expect(isPipelineJsonValue(item)).toBe(true);
    expect(leafReads).toBe(1);
  });

  it('rejects direct and indirect object cycles', () => {
    const direct: Record<string, unknown> = {};
    direct.self = direct;

    const first: Record<string, unknown> = {};
    const second: Record<string, unknown> = { first };
    first.second = second;

    expect(isPipelineJsonValue(direct)).toBe(false);
    expect(
      isPipelineJsonValue({
        first,
        repeated: first,
      }),
    ).toBe(false);
  });

  it('rejects a shared invalid node', () => {
    const invalid = { value: undefined };

    expect(
      isPipelineJsonValue({
        first: invalid,
        second: invalid,
      }),
    ).toBe(false);
  });

  it('enforces the active-depth boundary', () => {
    const nestedArrays = (depth: number): unknown => {
      let value: unknown = 'leaf';
      for (let index = 0; index < depth; index += 1) {
        value = [value];
      }
      return value;
    };

    expect(isPipelineJsonValue(nestedArrays(256))).toBe(true);
    expect(isPipelineJsonValue(nestedArrays(257))).toBe(false);
  });

  it('enforces the unique-container boundary', () => {
    const withinLimit: Record<string, unknown> = {};
    for (let index = 0; index < 9_999; index += 1) {
      withinLimit[String(index)] = {};
    }
    const overLimit = { ...withinLimit, overflow: {} };

    expect(isPipelineJsonValue(withinLimit)).toBe(true);
    expect(isPipelineJsonValue(overLimit)).toBe(false);
  });

  it('enforces the inspected-entry boundary', () => {
    expect(isPipelineJsonValue(new Array(100_000).fill(null))).toBe(true);
    expect(isPipelineJsonValue(new Array(100_001).fill(null))).toBe(false);
  });
});
