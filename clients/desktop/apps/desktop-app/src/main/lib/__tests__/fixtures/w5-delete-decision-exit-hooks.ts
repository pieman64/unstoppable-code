import {
  W5CommitLog,
  type W5CommitResult,
} from '@canopy/core-runtime/node/w5/commit-log';

// Crash after SQLite commits, before the real worker applies any file image.
const open = W5CommitLog.open.bind(W5CommitLog);
W5CommitLog.open = (
  ...args: Parameters<typeof W5CommitLog.open>
): W5CommitLog => {
  const log = open(...args);
  const commit = log.commit.bind(log);
  log.commit = (request): W5CommitResult => {
    const result = commit(request);
    if (
      request.operation === 'core.workspace.delete' &&
      result.status === 'committed'
    )
      process.exit(73);
    return result;
  };
  return log;
};
