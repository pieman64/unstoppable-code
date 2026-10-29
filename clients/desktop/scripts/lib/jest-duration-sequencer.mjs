import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import TestSequencer from '@jest/test-sequencer';

const manifest = JSON.parse(
  readFileSync(new URL('../jest-timings.json', import.meta.url), 'utf8'),
);

export function distributeTests(tests, shardCount, timings = manifest) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error('shardCount must be a positive integer');
  }
  if (
    timings.version !== 1 ||
    !Number.isFinite(timings.fallbackSeconds) ||
    timings.fallbackSeconds <= 0 ||
    !timings.tests ||
    typeof timings.tests !== 'object' ||
    Object.values(timings.tests).some(
      (value) => !Number.isFinite(value) || value <= 0,
    )
  ) {
    throw new Error('Invalid Jest timing manifest');
  }
  const work = tests.map((test, inputIndex) => {
    const key = relative(test.context.config.rootDir, test.path).replaceAll(
      '\\',
      '/',
    );
    return {
      test,
      inputIndex,
      key,
      seconds: timings.tests[key] ?? timings.fallbackSeconds,
    };
  });
  work.sort(
    (a, b) =>
      b.seconds - a.seconds || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const shards = Array.from({ length: shardCount }, () => ({
    seconds: 0,
    tests: [],
  }));
  for (const item of work) {
    const target = shards.reduce((best, shard) =>
      shard.seconds < best.seconds ||
      (shard.seconds === best.seconds && shard.tests.length < best.tests.length)
        ? shard
        : best,
    );
    target.tests.push(item);
    target.seconds += item.seconds;
  }
  for (const shard of shards) {
    shard.tests = shard.tests
      .sort((a, b) => a.inputIndex - b.inputIndex)
      .map((item) => item.test);
  }
  return shards;
}

export default class DurationSequencer extends TestSequencer {
  shard(tests, { shardIndex, shardCount }) {
    if (
      !Number.isInteger(shardIndex) ||
      shardIndex < 1 ||
      shardIndex > shardCount
    ) {
      throw new Error('Invalid Jest shard index');
    }
    return distributeTests(tests, shardCount)[shardIndex - 1].tests;
  }
}
