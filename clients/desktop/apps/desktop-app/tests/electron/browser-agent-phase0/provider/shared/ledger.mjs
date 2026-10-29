// Item-by-item requirement ledger for S0.1/S0.2. Every requirement ends with
// an explicit status per applicable phase; nothing is silently omitted.
import { CANARY_CATALOG } from './canaries.mjs';

/** Statuses. `pass`/`fail` are observed; the rest explain why not. */
export const STATUS = Object.freeze({
  pass: 'pass',
  fail: 'fail',
  blocked: 'blocked',
  notApplicable: 'n/a',
  unobserved: 'unobserved',
  measured: 'measured',
  unresolved: 'unresolved',
});

/** Phases of 05/README §8 "before first inference, after tools, compaction, completion, launch failure". */
export const PHASES = Object.freeze([
  'launch',
  'before-inference',
  'after-tools',
  'completion',
  'launch-failure',
  'compaction',
  'restart',
  'run',
]);

const BOTH = ['codex', 'claude'];

/**
 * Requirement catalog. `ref` points at the plan text; `phases` lists where a
 * result is expected. Sources: 05 §1.4, §1.12, §5 Phase 0 (lines 410-426),
 * 06 §1/§4, README §4 bounds and §8 assertions.
 */
export const REQUIREMENTS = Object.freeze([
  {
    id: 'followup.codex-surface',
    providers: ['codex'],
    phases: ['run'],
    ref: '05 §1.13; October 2 follow-up',
    text: 'Variant native tool exposure and browser wait collision.',
    followUp: true,
  },
  {
    id: 'followup.codex-wrapper',
    providers: ['codex'],
    phases: ['run'],
    ref: '05 §1.13; October 2 follow-up',
    text: 'Scripted wrapper host-file/environment/process/socket escape attempts.',
    followUp: true,
  },
  {
    id: 'followup.codex-notify',
    providers: ['codex'],
    phases: ['run'],
    ref: '05 §1.13; October 2 follow-up',
    text: 'Thread-scoped notify suppression without pool changes.',
    followUp: true,
  },
  {
    id: 'followup.claude-controls',
    providers: ['claude'],
    phases: ['run'],
    ref: '05 §1.13; October 2 follow-up',
    text: 'Memory flag, targeted controls and safe mode sources/tool loop comparison.',
    followUp: true,
  },
  {
    id: 'followup.claude-auth',
    providers: ['claude'],
    phases: ['run'],
    ref: '05 §1.13; October 2 follow-up',
    text: 'Production-shaped synthetic OAuth init only; custom endpoint evidence explicitly non-production.',
    followUp: true,
  },
  {
    id: 'followup.context',
    providers: ['codex', 'claude'],
    phases: ['run'],
    ref: '05 §1.13; October 2 follow-up',
    text: '125k context usage/checkpoint signals, continuation and compaction scope; synthetic calibration labeled.',
    followUp: true,
  },
  // Canonical state, verified before any turn.
  {
    id: 'canonical.home',
    providers: BOTH,
    phases: ['launch'],
    ref: '06 §1; bundled-runtime canonical home',
    text: 'HOME, CODEX_HOME / CLAUDE_CONFIG_DIR and the service-reported home are inside the synthetic root.',
  },
  {
    id: 'canonical.provider-url',
    providers: BOTH,
    phases: ['launch'],
    ref: 'task precondition',
    text: 'The effective model provider base URL is the dedicated loopback recorder.',
  },
  {
    id: 'canonical.no-credentials',
    providers: BOTH,
    phases: ['launch'],
    ref: 'task precondition',
    text: 'No real credential variables in the probe child or provider process environment; no credential files copied.',
  },
  {
    id: 'canonical.no-model-fallback',
    providers: BOTH,
    phases: ['launch'],
    ref: '06 §1',
    text: 'code_mode disabled and provider model fallback off; the model reported equals the model requested.',
  },
  {
    id: 'canonical.pins',
    providers: BOTH,
    phases: ['launch'],
    ref: '05 §5 Phase 0 (current pins)',
    text: 'Codex 0.159.0; Claude CLI 2.1.284; Agent SDK 0.3.284 resolved through the centralized resolver.',
  },
  {
    id: 'canonical.pool-profile',
    providers: ['codex'],
    phases: ['launch'],
    ref: '05 §1.12',
    text: 'Browser threads use the unchanged delegation spawn profile (restricted env, no secrets, :delegation environment, delegationCodexConfigArgs).',
  },
  // Launch controls.
  {
    id: 'launch.empty-cwd',
    providers: BOTH,
    phases: ['launch', 'completion'],
    ref: '05 §1.4',
    text: 'Fresh, empty working directory per epoch outside every repository; removed after the run.',
  },
  {
    id: 'launch.tool-surface',
    providers: BOTH,
    phases: ['before-inference', 'after-tools'],
    ref: 'README §8',
    text: 'The advertised tool set is exactly the derived browser tools (plus explicitly recorded provider built-ins).',
  },
  {
    id: 'launch.instruction-sources',
    providers: ['codex'],
    phases: ['launch'],
    ref: '05 §1.12 checks',
    text: 'thread/start instructionSources contains only the global AGENTS.md / AGENTS.override.md.',
  },
  {
    id: 'launch.config-read',
    providers: ['codex'],
    phases: ['launch'],
    ref: '05 §5 S0.1 exit',
    text: 'config/read layers recorded; ambient MCP servers disabled by name after normalization.',
  },
  {
    id: 'launch.hooks-list',
    providers: ['codex'],
    phases: ['launch'],
    ref: '05 §5 S0.1 exit',
    text: 'hooks/list recorded; hook canary never invoked.',
  },
  {
    id: 'launch.claude-init',
    providers: ['claude'],
    phases: ['launch'],
    ref: '05 §5 S0.1 exit',
    text: 'init message tools, skills, plugins, mcp_servers, slash_commands, output_style recorded and minimal.',
  },
  // Must-close checklist (05 lines 417-426).
  {
    id: 'close.claude-md-user',
    providers: ['claude'],
    phases: ['before-inference'],
    ref: '05 L417-418',
    text: 'User CLAUDE.md does not load with settingSources: [].',
  },
  {
    id: 'close.claude-md-managed',
    providers: ['claude'],
    phases: ['before-inference'],
    ref: '05 L417-418, L424-426',
    text: 'Managed (system) CLAUDE.md does not load. Needs a host system-path edit; the probe never makes one.',
  },
  {
    id: 'close.claude-disable-mds',
    providers: ['claude'],
    phases: ['before-inference'],
    ref: '05 L418',
    text: 'Effect of CLAUDE_CODE_DISABLE_CLAUDE_MDS compared with and without it.',
  },
  {
    id: 'close.claude-tools-empty',
    providers: ['claude'],
    phases: ['before-inference'],
    ref: '05 L419',
    text: 'tools: [] removes ToolSearch, Agent and Skill.',
  },
  {
    id: 'close.claude-between-tool',
    providers: ['claude'],
    phases: ['after-tools'],
    ref: '05 L420',
    text: 'The between-tool attachment pass injects no content.',
  },
  {
    id: 'close.codex-hooks-inert',
    providers: ['codex'],
    phases: ['after-tools', 'completion'],
    ref: '05 L421',
    text: 'Codex hooks stay inert under the overrides.',
  },
  {
    id: 'close.codex-mcp-inert',
    providers: ['codex'],
    phases: ['before-inference', 'after-tools'],
    ref: '05 L421-422',
    text: 'MCP servers declared in user config.toml stay inert (not advertised, not launched).',
  },
  {
    id: 'close.codex-notify-inert',
    providers: ['codex'],
    phases: ['completion'],
    ref: '05 L422',
    text: 'notify commands stay inert.',
  },
  {
    id: 'close.only-accepted-source',
    providers: BOTH,
    phases: ['before-inference', 'after-tools', 'completion', 'launch-failure'],
    ref: '05 L422-423',
    text: 'No source other than the accepted global AGENTS.md appears in instructionSources or outbound requests.',
  },
  {
    id: 'close.ephemeral-rollouts',
    providers: ['codex'],
    phases: ['completion'],
    ref: '05 L423-424',
    text: 'Ephemeral threads write no rollout files.',
  },
  {
    id: 'close.org-managed',
    providers: BOTH,
    phases: ['launch'],
    ref: '05 L424-426',
    text: 'Organization-managed instructions/hooks can be excluded, else the provider is unavailable for that account.',
  },
  // Codex accepted exception (06 §1).
  {
    id: 'codex.global-agents-counted',
    providers: ['codex'],
    phases: ['before-inference', 'after-tools'],
    ref: '05 §1.12, 06 §1',
    text: 'The accepted global AGENTS.md is present and its bytes counted in every request.',
  },
  {
    id: 'codex.global-agents-change',
    providers: ['codex'],
    phases: ['after-tools'],
    ref: '06 §1',
    text: 'Replacement/removal of the global file during an epoch is observed and recorded.',
  },
  {
    id: 'codex.warm-pool',
    providers: ['codex'],
    phases: ['run'],
    ref: '05 §5 S0.1; README §8',
    text: 'Browser threads run on the same warm pooled process that served a coding thread; PID/profile/thread identities recorded.',
  },
  // Rotation.
  {
    id: 'rotation.old-canary-absent',
    providers: BOTH,
    phases: ['run'],
    ref: 'README §8',
    text: 'Previous epoch page sentinels are absent from the next native session.',
  },
  {
    id: 'rotation.no-resume',
    providers: BOTH,
    phases: ['run'],
    ref: 'README §8',
    text: 'No earlier native session/thread id is resumed.',
  },
  {
    id: 'rotation.repeated-tools',
    providers: BOTH,
    phases: ['after-tools'],
    ref: '05 §1.3',
    text: 'A multi-step native tool loop with the derived tools completes.',
  },
  // Phases that cannot be observed here.
  {
    id: 'phase.compaction',
    providers: BOTH,
    phases: ['compaction'],
    ref: 'README §8',
    text: 'Canary absence after provider compaction attempts.',
  },
  {
    id: 'phase.restart',
    providers: BOTH,
    phases: ['restart'],
    ref: 'README §8',
    text: 'Canary absence and no resume after app restart.',
  },
  {
    id: 'phase.launch-failure',
    providers: BOTH,
    phases: ['launch-failure'],
    ref: 'README §8',
    text: 'Canary absence in whatever was sent before an induced launch/turn failure.',
  },
  // Budgeting and S0.2.
  {
    id: 'budget.pre-request',
    providers: BOTH,
    phases: ['run'],
    ref: '06 §4',
    text: 'A pre-request hook or conservative enforced bound exists for the 16,000-token request budget.',
  },
  {
    id: 's02.session-start',
    providers: BOTH,
    phases: ['run'],
    ref: '05 §5 S0.2',
    text: 'Fresh-session start time, cold and warm.',
  },
  {
    id: 's02.harness-overhead',
    providers: BOTH,
    phases: ['run'],
    ref: '05 §5 S0.2',
    text: 'Harness overhead bytes per request (instructions, schemas, framing).',
  },
  {
    id: 's02.page-growth',
    providers: BOTH,
    phases: ['run'],
    ref: '05 §5 S0.2',
    text: 'Request growth across repeated 100-control / 6,000-character observations on one page.',
  },
  {
    id: 's02.token-accounting',
    providers: BOTH,
    phases: ['run'],
    ref: '05 §5 S0.2',
    text: 'Provider-reported usage recorded and labelled synthetic (mock) versus byte estimates.',
  },
  {
    id: 's02.guard-recommendation',
    providers: BOTH,
    phases: ['run'],
    ref: '06 §4',
    text: 'Per-page context guard and finite epoch cap recommendation, or unresolved.',
  },
  // Hygiene.
  {
    id: 'hygiene.no-external-requests',
    providers: BOTH,
    phases: ['run'],
    ref: 'task precondition',
    text: 'No non-loopback connection observed from the probe process tree.',
  },
  {
    id: 'hygiene.cleanup',
    providers: BOTH,
    phases: ['completion'],
    ref: 'task precondition',
    text: 'No leaked descendants or listening sockets; synthetic root removed.',
  },
  // One canary requirement per catalog source.
  ...CANARY_CATALOG.map((entry) => ({
    id: `canary.${entry.id}`,
    providers: entry.providers,
    phases: ['before-inference', 'after-tools', 'completion', 'launch-failure'],
    ref: 'README §8 canary assertions',
    text: `${entry.where}: expected ${entry.expected} in every outbound channel.`,
  })),
]);

const BY_ID = new Map(
  REQUIREMENTS.map((requirement) => [requirement.id, requirement]),
);

/** A ledger for one provider. */
export function createLedger(provider, { followUp = false } = {}) {
  const entries = [];
  return {
    provider,
    /**
     * @param {string} id requirement id
     * @param {string} phase one of PHASES
     * @param {string} status one of STATUS
     * @param {unknown} evidence small JSON-serializable evidence or reason
     */
    record(id, phase, status, evidence) {
      const requirement = BY_ID.get(id);
      if (!requirement) throw new Error(`Unknown requirement ${id}`);
      if (!PHASES.includes(phase)) throw new Error(`Unknown phase ${phase}`);
      if (!Object.values(STATUS).includes(status))
        throw new Error(`Unknown status ${status}`);
      if (
        !requirement.providers.includes(provider) &&
        status !== STATUS.notApplicable
      )
        throw new Error(`${id} does not apply to ${provider}`);
      entries.push({ id, phase, status, evidence: evidence ?? null });
    },
    entries: () => entries.map((entry) => ({ ...entry })),
    /** Fill every missing (requirement, phase) as unobserved and summarize. */
    finalize(unreachedReason = 'not reached in this run') {
      const out = [];
      for (const requirement of REQUIREMENTS.filter(
        (item) => followUp || !item.followUp,
      )) {
        const applies = requirement.providers.includes(provider);
        for (const phase of requirement.phases) {
          const found = entries.filter(
            (entry) => entry.id === requirement.id && entry.phase === phase,
          );
          if (found.length > 0) out.push(...found);
          else
            out.push({
              id: requirement.id,
              phase,
              status: applies ? STATUS.unobserved : STATUS.notApplicable,
              evidence: applies
                ? { reason: unreachedReason }
                : { reason: `does not apply to ${provider}` },
            });
        }
      }
      const counts = {};
      for (const entry of out)
        counts[entry.status] = (counts[entry.status] ?? 0) + 1;
      return {
        provider,
        counts,
        failed: out.some((entry) => entry.status === STATUS.fail),
        entries: out,
      };
    },
  };
}
