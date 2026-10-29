import { deriveChatWorkflowCapabilities } from '../chat-workflow-capabilities';
import type { ChatWorkflowTarget } from '../chat-workflow-capabilities';

const base = {
  resolvedProvider: 'cursor',
  interfaceMode: 'canopy',
  target: 'worktree' as const,
  capabilities: {
    automations: true,
    worktreeBranching: true,
    pipelines: 'execute' as const,
    chatWorkflows: {
      planMode: true,
      planReview: true,
      deferredCapabilities: true,
      independentFork: true,
    },
  },
};

test('enables Cursor workflows separately and keeps deferred loading closed', () => {
  expect(deriveChatWorkflowCapabilities(base)).toEqual({
    scheduledMessages: false,
    planMode: true,
    planReview: true,
    planImplementation: false,
    planPipeline: false,
    deferredCapabilities: false,
    independentFork: false,
    branchedFork: false,
  });
});

test.each(['claude', 'codex', 'ollama', 'cursor', 'copilot', 'opencode'])(
  'preserves provider decisions for %s',
  (resolvedProvider) => {
    const result = deriveChatWorkflowCapabilities({
      ...base,
      resolvedProvider,
    });
    const supported = resolvedProvider !== 'copilot';
    expect(result.scheduledMessages).toBe(
      (supported && resolvedProvider !== 'cursor') ||
        resolvedProvider === 'opencode',
    );
    expect(result.planMode).toBe(supported);
    expect(result.planReview).toBe(supported);
    expect(result.planImplementation).toBe(
      ['claude', 'codex', 'ollama', 'opencode'].includes(resolvedProvider),
    );
    expect(result.planPipeline).toBe(
      ['claude', 'codex', 'ollama', 'opencode'].includes(resolvedProvider),
    );
    expect(result.independentFork).toBe(
      ['claude', 'codex'].includes(resolvedProvider),
    );
    expect(result.deferredCapabilities).toBe(
      ['claude', 'codex', 'ollama'].includes(resolvedProvider),
    );
  },
);

test.each<ChatWorkflowTarget>([
  'worktree',
  'cowork',
  'app-advisor-entry',
  'app-advisor-global',
  'pipeline-assistant',
  'code-review',
  'cloud',
])('restricts Cursor forks and scheduling at %s', (target) => {
  const result = deriveChatWorkflowCapabilities({ ...base, target });
  expect(result.independentFork).toBe(false);
  expect(result.branchedFork).toBe(false);
  expect(result.scheduledMessages).toBe(false);
});

test('requires host support and does not require local execution for paired plan editing', () => {
  expect(deriveChatWorkflowCapabilities({ ...base, capabilities: {} })).toEqual(
    {
      scheduledMessages: false,
      planMode: false,
      planReview: false,
      planImplementation: false,
      planPipeline: false,
      deferredCapabilities: false,
      independentFork: false,
      branchedFork: false,
    },
  );
  const paired = deriveChatWorkflowCapabilities({
    ...base,
    capabilities: { chatWorkflows: { planMode: true, independentFork: true } },
  });
  expect(paired.planMode).toBe(true);
  expect(paired.independentFork).toBe(false);
  expect(paired.planReview).toBe(false);
  expect(paired.scheduledMessages).toBe(false);
});

test.each([
  { resolvedProvider: undefined },
  { resolvedProvider: 'unknown' },
  { interfaceMode: undefined },
  { interfaceMode: 'unknown' },
  { target: undefined },
  { interfaceMode: 'claude-code' },
])('fails closed for unresolved or incompatible inputs %j', (override) => {
  expect(
    Object.values(deriveChatWorkflowCapabilities({ ...base, ...override })),
  ).not.toContain(true);
});
