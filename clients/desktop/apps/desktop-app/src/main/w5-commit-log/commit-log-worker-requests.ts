import {
  W5CommitLogRequestHandler as W5PortableRequestHandler,
  type W5CommitLog,
  type W5CommitLogRequest,
  type W5CommitLogWorkerData,
  type W5RecoveryReport,
} from '@canopy/core-runtime/node/w5/commit-log';
import { desktopW5Durability } from '@canopy/desktop-shared/node/w5-commit-log/durability';

export {
  MALFORMED_REQUEST_MESSAGE,
  toW5CommitLogWorkerError,
} from '@canopy/core-runtime/node/w5/commit-log';

/** The portable request handler, writing through the desktop's durability. */
export class W5CommitLogRequestHandler {
  private readonly handler: W5PortableRequestHandler;

  constructor(
    log: W5CommitLog,
    data: W5CommitLogWorkerData,
    recovery: W5RecoveryReport,
  ) {
    this.handler = new W5PortableRequestHandler(
      log,
      data,
      recovery,
      desktopW5Durability,
    );
  }

  run(request: W5CommitLogRequest): Promise<unknown> {
    return this.handler.run(request);
  }
}
