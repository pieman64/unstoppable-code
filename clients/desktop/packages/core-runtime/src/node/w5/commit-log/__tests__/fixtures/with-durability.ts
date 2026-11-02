// The commit log as a host composes it, for suites that exercise the applier,
// writing through the node:fs port a daemon host composes.
import {
  applyW5Commit as applyW5CommitWith,
  recoverW5CommitLog as recoverW5CommitLogWith,
  type W5ApplyOptions as W5PortableApplyOptions,
  type W5ApplyResult,
  type W5CommitLog,
  type W5DurabilityPort,
  type W5PendingCommit,
  type W5RecoveryReport,
} from '../..';
import { createNodeW5Durability } from '../../node-durability';

export * from '../..';

export const testW5Durability: W5DurabilityPort = createNodeW5Durability(
  process.platform,
);

export type W5ApplyOptions = Omit<W5PortableApplyOptions, 'durability'> &
  Partial<Pick<W5PortableApplyOptions, 'durability'>>;

export function applyW5Commit(
  log: W5CommitLog,
  commit: W5PendingCommit,
  options: W5ApplyOptions,
): Promise<W5ApplyResult> {
  return applyW5CommitWith(log, commit, {
    ...options,
    durability: options.durability ?? testW5Durability,
  });
}

export function recoverW5CommitLog(
  log: W5CommitLog,
  options: W5ApplyOptions,
): Promise<W5RecoveryReport> {
  return recoverW5CommitLogWith(log, {
    ...options,
    durability: options.durability ?? testW5Durability,
  });
}
