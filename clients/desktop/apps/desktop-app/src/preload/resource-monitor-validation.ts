import type {
  ResourceGroupId,
  ResourceMonitorSnapshot,
  ResourcePressureLevel,
  ResourceProcessKind,
} from '@canopy/desktop-shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isResourceGroupId(value: unknown): value is ResourceGroupId {
  return (
    value === 'app' ||
    value === 'browser' ||
    value === 'codex' ||
    value === 'claude' ||
    value === 'chat' ||
    value === 'pipelines' ||
    value === 'terminal' ||
    value === 'scripts' ||
    value === 'other'
  );
}

function isResourceProcessKind(value: unknown): value is ResourceProcessKind {
  return (
    value === 'electron-main' ||
    value === 'electron-renderer' ||
    value === 'electron-utility' ||
    value === 'electron-gpu' ||
    value === 'in-app-browser' ||
    value === 'codex-app-server-pool' ||
    value === 'pipeline-execution' ||
    value === 'pipeline-step' ||
    value === 'chat-provider' ||
    value === 'terminal' ||
    value === 'script' ||
    value === 'hook' ||
    value === 'other'
  );
}

function isResourcePressureLevel(
  value: unknown,
): value is ResourcePressureLevel {
  return (
    value === 'unknown' ||
    value === 'ok' ||
    value === 'warning' ||
    value === 'critical'
  );
}

function isResourceProcessStatus(value: unknown): boolean {
  return (
    value === 'running' ||
    value === 'idle' ||
    value === 'exited' ||
    value === 'unknown'
  );
}

function isResourceMetadata(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === 'generic') {
    return true;
  }
  if (value.type === 'codex-pool') {
    const codexPool = value.codexPool;
    return (
      isRecord(codexPool) &&
      typeof codexPool.poolKeyLabel === 'string' &&
      typeof codexPool.pooled === 'boolean' &&
      typeof codexPool.clientCount === 'number' &&
      typeof codexPool.activeTurnCount === 'number' &&
      typeof codexPool.initialized === 'boolean'
    );
  }
  if (value.type === 'pipeline') {
    const pipeline = value.pipeline;
    return (
      isRecord(pipeline) &&
      typeof pipeline.executionId === 'string' &&
      (pipeline.pipelineId === undefined ||
        typeof pipeline.pipelineId === 'string') &&
      (pipeline.pipelineName === undefined ||
        typeof pipeline.pipelineName === 'string') &&
      (pipeline.jobId === undefined || typeof pipeline.jobId === 'string') &&
      (pipeline.stepId === undefined || typeof pipeline.stepId === 'string') &&
      (pipeline.attempt === undefined ||
        typeof pipeline.attempt === 'number') &&
      (pipeline.iteration === undefined ||
        typeof pipeline.iteration === 'number')
    );
  }
  if (value.type === 'browser') {
    const browser = value.browser;
    return (
      isRecord(browser) &&
      typeof browser.projectId === 'string' &&
      typeof browser.worktreeId === 'string' &&
      typeof browser.browserId === 'string' &&
      (browser.title === undefined || typeof browser.title === 'string') &&
      (browser.displayUrl === undefined ||
        typeof browser.displayUrl === 'string') &&
      typeof browser.visible === 'boolean' &&
      (browser.status === 'idle' ||
        browser.status === 'loading' ||
        browser.status === 'ready' ||
        browser.status === 'failed')
    );
  }
  if (value.type === 'script') {
    const script = value.script;
    return (
      isRecord(script) &&
      typeof script.projectId === 'string' &&
      typeof script.worktreeId === 'string' &&
      typeof script.scriptKey === 'string' &&
      typeof script.scriptName === 'string' &&
      typeof script.scriptLabel === 'string' &&
      (script.target === 'project' ||
        script.target === 'workspace-repo' ||
        script.target === 'workspace-root') &&
      (script.repoId === undefined || typeof script.repoId === 'string') &&
      (script.repoName === undefined || typeof script.repoName === 'string') &&
      (script.invocation === undefined ||
        script.invocation === 'automatic-setup' ||
        script.invocation === 'manual-run' ||
        script.invocation === 'manual-lifecycle' ||
        script.invocation === 'workspace-lifecycle')
    );
  }
  return false;
}

function isResourceProcessSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isResourceProcessKind(value.kind) &&
    isResourceGroupId(value.groupId) &&
    typeof value.label === 'string' &&
    (value.pid === undefined || typeof value.pid === 'number') &&
    (value.ppid === undefined || typeof value.ppid === 'number') &&
    (value.processGroupId === undefined ||
      typeof value.processGroupId === 'number') &&
    typeof value.cpuPercent === 'number' &&
    typeof value.memoryRssBytes === 'number' &&
    typeof value.processCount === 'number' &&
    (value.startedAt === undefined || typeof value.startedAt === 'string') &&
    isResourceProcessStatus(value.status) &&
    (value.metadata === undefined || isResourceMetadata(value.metadata)) &&
    (value.children === undefined ||
      (Array.isArray(value.children) &&
        value.children.every((child) => isResourceProcessSnapshot(child))))
  );
}

function isResourceGroupSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    isResourceGroupId(value.id) &&
    typeof value.label === 'string' &&
    typeof value.cpuPercent === 'number' &&
    typeof value.memoryRssBytes === 'number' &&
    typeof value.processCount === 'number' &&
    Array.isArray(value.items) &&
    value.items.every((item) => isResourceProcessSnapshot(item))
  );
}

export function isResourceMonitorSnapshot(
  value: unknown,
): value is ResourceMonitorSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  const pressure = value.pressure;
  const guards = value.guards;
  if (!isRecord(pressure) || !isRecord(guards)) {
    return false;
  }
  const chatTurns = guards.chatTurns;
  const pipelines = guards.pipelines;
  const codexPools = guards.codexPools;
  return (
    value.version === 1 &&
    typeof value.sampledAt === 'string' &&
    typeof value.appPid === 'number' &&
    typeof value.cpuPercent === 'number' &&
    typeof value.memoryRssBytes === 'number' &&
    typeof value.processCount === 'number' &&
    isResourcePressureLevel(pressure.level) &&
    Array.isArray(pressure.reasons) &&
    pressure.reasons.every((reason) => typeof reason === 'string') &&
    typeof pressure.warningMemoryBytes === 'number' &&
    typeof pressure.criticalMemoryBytes === 'number' &&
    Array.isArray(value.groups) &&
    value.groups.every((group) => isResourceGroupSnapshot(group)) &&
    isRecord(chatTurns) &&
    typeof chatTurns.activeTurns === 'number' &&
    typeof chatTurns.pendingMessages === 'number' &&
    isNullableNumber(chatTurns.maxConcurrentTurns) &&
    typeof chatTurns.blocked === 'boolean' &&
    isRecord(pipelines) &&
    typeof pipelines.activeExecutions === 'number' &&
    isNullableNumber(pipelines.maxConcurrentExecutions) &&
    typeof pipelines.blocked === 'boolean' &&
    isRecord(codexPools) &&
    typeof codexPools.activeConnections === 'number' &&
    typeof codexPools.liveProcesses === 'number' &&
    typeof codexPools.activeTurns === 'number' &&
    (value.error === undefined || typeof value.error === 'string')
  );
}
