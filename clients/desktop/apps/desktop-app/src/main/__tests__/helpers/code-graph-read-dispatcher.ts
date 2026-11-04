import { createCanopyDispatcher } from '@canopy/core-runtime';
import {
  WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS,
  WORKER_CODE_GRAPH_WRITE_INSTRUCTION_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import type { WorkerCodeGraphReadHandlers } from '@canopy/core-runtime/node/code-graph';
import { createWorkerCodeGraphReadAdapter } from '../../canopy-runtime/worker-code-graph-read-adapter';
import { setCodeGraphReadDispatcherForTests } from '../../code-graph/graph-reads';

/**
 * Routes Electron main's code-graph reads through a dispatcher over the real
 * `worker.codeGraph` definitions and adapter, as the desktop runtime does,
 * without composing the whole runtime. Returns the uninstall.
 */
export function installCodeGraphReadDispatcherForTests(
  adapter: WorkerCodeGraphReadHandlers = createWorkerCodeGraphReadAdapter(),
): () => void {
  const dispatcher = createCanopyDispatcher({
    profile: 'worker',
    definitions: {
      queries: WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS,
      instructions: WORKER_CODE_GRAPH_WRITE_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: adapter.queries,
      instructions: adapter.instructions,
      streams: {},
    },
  });
  // The helper's dispatcher serves only the code-graph subset of the desktop's.
  setCodeGraphReadDispatcherForTests(dispatcher);
  return () => setCodeGraphReadDispatcherForTests(null);
}
