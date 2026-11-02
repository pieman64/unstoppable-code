import type { RepoRulesScanRequest } from '@canopy/protocol/repo-rules';
import {
  RepoRulesPolicy,
  type RepoRulesStorePort,
} from '@canopy/core-runtime/node/workspace/repo-rules';
import type { RepoCheckout } from './discovery';
import { repoRulesWorker, type RepoRulesWorkerPort } from './worker';

/** The core repository-rule policy bound to the same-process checkout worker. */
export class RepoRulesService extends RepoRulesPolicy {
  constructor(
    store: RepoRulesStorePort,
    resolve: (request: RepoRulesScanRequest) => Promise<RepoCheckout[]>,
    now: () => number = Date.now,
    worker: RepoRulesWorkerPort = repoRulesWorker,
  ) {
    super({ store, resolve, worker, now });
  }
}
