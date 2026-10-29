import type {
  CostChatRequest,
  CostChatView,
  CostPipelineRunRequest,
  CostRefreshReceipt,
  CostRefreshRequest,
  CostScopeRequest,
  CostScopeView,
  CostViewResult,
  CostErrorReason,
  PipelineRunCostView,
} from '@canopy/protocol/cost-view';
import { CostServiceError } from './errors';
import type { CostServiceErrorReason } from './errors';
import { getDesktopCostIndexHost } from './host';
import { CostIndexStore } from './store';

export { CostServiceError } from './errors';
export type { CostServiceErrorReason } from './errors';

/** Service methods return immutable DTOs directly; callers never handle wrappers. */
export interface CostService {
  getScope(request: CostScopeRequest): Promise<CostScopeView>;
  getChat(request: CostChatRequest): Promise<CostChatView>;
  getPipelineRun(request: CostPipelineRunRequest): Promise<PipelineRunCostView>;
  refresh(request: CostRefreshRequest): Promise<CostRefreshReceipt>;
}

function unwrap<Value>(result: CostViewResult<Value>): Value {
  switch (result.status) {
    case 'ok':
      return result.value;
    case 'unavailable':
      throw new CostServiceError(result.reason);
    case 'error':
      throw new CostServiceError(mapErrorReason(result.reason), result.message);
  }
}

function mapErrorReason(reason: CostErrorReason): CostServiceErrorReason {
  if (reason === 'NOT_FOUND' || reason === 'SCOPE_SEALED') return reason;
  return 'UNKNOWN';
}

class DesktopCostService implements CostService {
  public constructor(private readonly store: CostIndexStore) {}

  public async getScope(request: CostScopeRequest): Promise<CostScopeView> {
    return unwrap(await this.store.getScope(request));
  }

  public async getChat(request: CostChatRequest): Promise<CostChatView> {
    return unwrap(await this.store.getChat(request));
  }

  public async getPipelineRun(
    request: CostPipelineRunRequest,
  ): Promise<PipelineRunCostView> {
    return unwrap(await this.store.getPipelineRun(request));
  }

  public async refresh(
    request: CostRefreshRequest,
  ): Promise<CostRefreshReceipt> {
    return unwrap(await this.store.refresh(request));
  }
}

let desktopStore: CostIndexStore | null = null;
let desktopService: CostService | null = null;

/** The host and index are initialized only when the first caller needs them. */
export function getDesktopCostIndexStore(): CostIndexStore {
  if (desktopStore !== null) return desktopStore;
  try {
    desktopStore = new CostIndexStore(getDesktopCostIndexHost());
    return desktopStore;
  } catch (error) {
    throw new CostServiceError(
      'runtime_unavailable',
      error instanceof Error ? error.message : 'Cost index runtime unavailable',
    );
  }
}

export function getDesktopCostService(): CostService {
  if (desktopService !== null) return desktopService;
  desktopService = new DesktopCostService(getDesktopCostIndexStore());
  return desktopService;
}

/** Tests reset only the lazy in-memory facade, never durable index files. */
export function resetDesktopCostServiceForTest(): void {
  desktopStore = null;
  desktopService = null;
}
