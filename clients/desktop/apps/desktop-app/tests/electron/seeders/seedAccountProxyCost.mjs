import { readFileSync, writeFileSync } from 'node:fs';

/** The fake proxy's accounts (`fixtures/fake-account-proxy.mjs`). */
export const PROXY_COST_ACCOUNTS = {
  sam: 'a1f3c2d4a1f3c2d4',
  ops: '9b07e1aa9b07e1aa',
};

/**
 * Rewrites the cost fixture's audit entries as the account proxy records
 * them (CAN-4021): billed `account_proxy`, with the accounts that served each
 * entry. `served` maps an audit entry's chat id or `<executionId>/<jobId>/
 * <attempt>` to `{ <account>: <responses> }`.
 *
 * @param {readonly string[]} auditFiles from `seedCostInsights`
 * @param {object} options
 * @param {string} options.connectionId the proxy connection the accounts belong to
 * @param {Record<string, Record<string, number>>} options.served
 * @returns {number} the entries rewritten
 */
export function markAccountProxyCost(auditFiles, { connectionId, served }) {
  let marked = 0;
  for (const file of auditFiles) {
    const lines = readFileSync(file, 'utf8').split('\n');
    const next = lines.map((line) => {
      if (!line.trim()) return line;
      const entry = JSON.parse(line);
      const key =
        entry.eventType === 'pipeline_agent_turn'
          ? `${entry.pipelineExecutionId}/${entry.jobId}/${entry.attempt ?? 0}`
          : entry.eventType === 'worktree_chat'
            ? entry.chatId
            : undefined;
      const accounts = key === undefined ? undefined : served[key];
      if (!accounts) return line;
      marked += 1;
      return JSON.stringify({
        ...entry,
        billingBasis: 'account_proxy',
        accountProxy: {
          connectionId,
          accounts: Object.entries(accounts).map(([name, requests]) => ({
            authIndex: PROXY_COST_ACCOUNTS[name],
            provider: 'claude',
            requests,
          })),
        },
      });
    });
    writeFileSync(file, next.join('\n'));
  }
  if (marked === 0) throw new Error('No audit entries to mark as proxy served');
  return marked;
}
