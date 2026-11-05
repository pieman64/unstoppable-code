import type {
  AgentAuditEntry,
  AgentAuditToolCounts,
} from '@canopy/desktop-shared/types';

/**
 * Plain audit entries the loading skeleton measures. They never show:
 * skullet draws over them, unseen and inert.
 */

const NO_TOOL_USES: AgentAuditToolCounts = {
  thinking: 0,
  bash: 0,
  read: 0,
  readLines: 0,
  writeEdit: 0,
  plan: 0,
  fileEdit: 0,
  fileAdd: 0,
  fileDelete: 0,
  search: 0,
  grep: 0,
  web: 0,
  agent: 0,
  workflow: 0,
  tasks: 0,
  taskStop: 0,
  skills: 0,
  monitor: 0,
  claude: 0,
  scheduleWakeup: 0,
  askUser: 0,
  scriptOutput: 0,
  watcher: 0,
  canopy: 0,
  graph: 0,
  appAdvisor: 0,
  pipelineEditor: 0,
  mcp: 0,
  other: 0,
};

function sampleEntry(id: string, label: string): AgentAuditEntry {
  return {
    id,
    eventType: 'standalone_chat',
    status: 'success',
    provider: 'claude',
    label,
    startedAt: '2026-01-01T12:00:00.000Z',
    completedAt: '2026-01-01T12:04:00.000Z',
    model: 'claude-sonnet',
    tokens: {
      input: 1200,
      output: 800,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    messageCount: 6,
    assistantMessageCount: 3,
    toolUseCount: 4,
    subAgentCount: 0,
    toolCounts: NO_TOOL_USES,
    hasTranscript: true,
  };
}

export const SAMPLE_AUDIT_ENTRIES: readonly AgentAuditEntry[] = [
  sampleEntry('audit-sample-1', 'Fix the checkout retry test'),
  sampleEntry('audit-sample-2', 'Update the docs sidebar'),
  sampleEntry('audit-sample-3', 'Add release notes'),
];
