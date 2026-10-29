import { randomUUID } from 'node:crypto';
import type {
  RepoRulesScanRequest,
  RepoRulesScanResponse,
  RepoRulesApplyRequest,
  RepoRulesApplyResponse,
  RepoRulesPreviewRequest,
  RepoRulesPreviewResponse,
  RepoRulesStatus,
} from '@canopy/protocol/repo-rules';
import type { RulesRead, RepoCheckout } from './discovery';
import { repoRulesWorker, type RepoRulesWorkerPort } from './worker';
import {
  type RepoRulesState,
  type RepoRulesStateStore,
  REPO_RULES_POLICY_MAX_BYTES,
  REVIEWED_HISTORY_LIMIT,
  policyStatus,
} from './state';
import { renderRepoRules } from './rendering';

type ReviewHistory = RepoRulesState['reviewed'];

/**
 * Adds the most recent reviews from other checkouts to `next`, which holds
 * this scan's reviews, while the record count and serialized policy stay
 * within their limits. A dropped record only makes that rule need review
 * again before a malformed version of it is used; saved disables are kept
 * separately and never depend on it.
 */
function retainReviewHistory(
  previous: ReviewHistory,
  next: RepoRulesState,
): RepoRulesState {
  const reviewed: ReviewHistory = { ...next.reviewed };
  let count = Object.keys(reviewed).length;
  let bytes = Buffer.byteLength(JSON.stringify({ ...next, reviewed }));
  const others = Object.entries(previous)
    .filter(([id]) => reviewed[id] === undefined)
    .sort(([, a], [, b]) => b.reviewedAt.localeCompare(a.reviewedAt));
  for (const [id, record] of others) {
    if (count >= REVIEWED_HISTORY_LIMIT) break;
    // A comma plus `"id":{...}`; never less than what the entry adds.
    const added = Buffer.byteLength(JSON.stringify({ [id]: record })) - 1;
    if (bytes + added > REPO_RULES_POLICY_MAX_BYTES) break;
    reviewed[id] = record;
    count += 1;
    bytes += added;
  }
  return { ...next, reviewed };
}

interface Scan {
  scannedAt: number;
  caller: string;
  request: RepoRulesScanRequest;
  repos: RepoCheckout[];
  revision: number;
  expires: number;
  read: RulesRead;
}
export class RepoRulesService {
  private readonly scans = new Map<string, Scan>();
  constructor(
    private readonly store: RepoRulesStateStore,
    private readonly resolve: (
      request: RepoRulesScanRequest,
    ) => Promise<RepoCheckout[]>,
    private readonly now: () => number = Date.now,
    private readonly worker: RepoRulesWorkerPort = repoRulesWorker,
  ) {}
  async status(workspaceId: string): Promise<RepoRulesStatus> {
    return policyStatus(await this.store.read(workspaceId));
  }
  private prune(): void {
    for (const [key, scan] of Array.from(this.scans))
      if (scan.expires <= this.now()) this.scans.delete(key);
    while (this.scans.size >= 8) {
      const key = this.scans.keys().next().value;
      if (key === undefined) break;
      this.scans.delete(key);
    }
  }
  async scan(
    caller: string,
    request: RepoRulesScanRequest,
  ): Promise<RepoRulesScanResponse> {
    this.prune();
    const state = await this.store.read(request.workspaceId);
    const repos = await this.resolve(request);
    const read = await this.worker.scan(repos);
    for (const rule of read.rules) {
      // A saved disable holds even after its review record left the history.
      if (state.disabledRuleIds.includes(rule.id)) rule.selected = false;
      else if (state.reviewed[rule.id]) rule.selected = true;
    }
    const scanId = randomUUID();
    this.prune();
    this.scans.set(scanId, {
      scannedAt: this.now(),
      caller,
      request,
      repos,
      revision: state.revision,
      read,
      expires: this.now() + 10 * 60 * 1000,
    });
    return {
      scanId,
      enabled: state.enabled,
      revision: state.revision,
      worktreeId: request.worktreeId,
      proposals: read.rules.map((rule) => ({
        id: rule.id,
        repoId: rule.repoId,
        path: rule.path,
        kind: rule.kind,
        description: rule.description,
        globs: rule.globs,
        scope: rule.scope,
        hash: rule.hash,
        bytes: rule.bytes,
        selected: rule.selected,
        flags: rule.flags,
      })),
      nestedDirectories: read.nestedDirectories,
      skipped: read.skipped,
      diagnostic: state.diagnostic,
    };
  }
  private reviewedScan(
    caller: string,
    workspaceId: string,
    scanId: string | undefined,
  ): Scan {
    const scan = scanId ? this.scans.get(scanId) : undefined;
    if (
      !scan ||
      scan.caller !== caller ||
      scan.request.workspaceId !== workspaceId ||
      scan.expires <= this.now()
    )
      throw new Error('This review is unavailable or expired. Scan again.');
    return scan;
  }
  preview(
    caller: string,
    request: RepoRulesPreviewRequest,
  ): RepoRulesPreviewResponse {
    const scan = this.reviewedScan(caller, request.workspaceId, request.scanId);
    const rule = scan.read.rules.find((r) => r.id === request.ruleId);
    if (!rule) throw new Error('This rule is not in the review. Scan again.');
    return { body: rule.body };
  }
  async apply(
    caller: string,
    request: RepoRulesApplyRequest,
  ): Promise<RepoRulesApplyResponse> {
    const result = await this.store.update(
      request.workspaceId,
      async (current) => {
        if (!request.scanId && request.disabledRuleIds !== undefined)
          throw new Error('A review is required to change rule selections.');
        if (!request.enabled && !request.scanId)
          return {
            version: 1,
            enabled: false,
            disabledRuleIds: current.disabledRuleIds,
            revision: current.revision + 1,
            reviewed: current.reviewed,
            nestedDirectories: current.nestedDirectories,
            reviewedAt: current.reviewedAt,
            lastScanAt: current.lastScanAt,
          };
        const scan = this.reviewedScan(
          caller,
          request.workspaceId,
          request.scanId,
        );
        if (current.revision !== scan.revision)
          throw new Error('Workspace policy changed. Scan again.');
        const disabled = request.disabledRuleIds;
        if (
          !disabled ||
          new Set(disabled).size !== disabled.length ||
          disabled.some((id) => !scan.read.rules.some((r) => r.id === id))
        )
          throw new Error('Selections must belong to this review.');
        const repos = await this.resolve(scan.request);
        if (JSON.stringify(repos) !== JSON.stringify(scan.repos))
          throw new Error('The reviewed checkout changed. Scan again.');
        const fresh = await this.worker.scan(repos);
        const fingerprint = (read: RulesRead): string =>
          JSON.stringify({
            rules: read.rules.map((r) => [r.id, r.hash]),
            skipped: read.skipped,
            directories: read.nestedDirectories,
          });
        if (fingerprint(fresh) !== fingerprint(scan.read))
          throw new Error(
            'Cursor rules changed since this review. Scan again.',
          );
        // Expiry is checked again after asynchronous verification. The scan is
        // consumed only once the atomic policy write succeeds.
        this.reviewedScan(caller, request.workspaceId, request.scanId);
        const time = new Date(this.now()).toISOString();
        return retainReviewHistory(current.reviewed, {
          version: 1,
          enabled: request.enabled,
          revision: current.revision + 1,
          disabledRuleIds: Array.from(
            new Set([
              ...current.disabledRuleIds.filter(
                (id) => !fresh.rules.some((r) => r.id === id),
              ),
              ...disabled,
            ]),
          ),
          reviewed: Object.fromEntries(
            fresh.rules.map((r) => [r.id, { hash: r.hash, reviewedAt: time }]),
          ),
          nestedDirectories: {
            ...current.nestedDirectories,
            ...fresh.nestedDirectories,
          },
          reviewedAt: time,
          lastScanAt: new Date(scan.scannedAt).toISOString(),
        });
      },
    );
    if (request.scanId) this.scans.delete(request.scanId);
    return policyStatus(result);
  }
  async compose(workspaceId: string, repos?: RepoCheckout[]): Promise<string> {
    try {
      const state = await this.store.read(workspaceId);
      if (!state.enabled) return '';
      const checkouts = repos ?? (await this.resolve({ workspaceId }));
      const read = await this.worker.readSession(
        checkouts,
        state.nestedDirectories,
      );
      for (const rule of read.rules) {
        rule.selected =
          !state.disabledRuleIds.includes(rule.id) &&
          (!rule.flags.includes('malformed-frontmatter') ||
            state.reviewed[rule.id] !== undefined);
      }
      return renderRepoRules(read.rules, checkouts, read.skipped.length);
    } catch {
      return '';
    }
  }
}
