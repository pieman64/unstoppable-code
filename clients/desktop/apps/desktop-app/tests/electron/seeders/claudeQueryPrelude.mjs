const E2E_CLAUDE_QUERY_PRELUDE_KEY = '__CANOPY_E2E_CLAUDE_QUERY_PRELUDE__';

async function useControl(electronApp, operation, scope) {
  if (!electronApp) {
    throw new Error('Claude query prelude control requires an electronApp');
  }
  return electronApp.evaluate(
    async (_electron, { key, operationName, exactScope }) => {
      const control = globalThis[key];
      const method = control?.[operationName];
      if (typeof method !== 'function') {
        throw new Error('E2E Claude query prelude control is unavailable');
      }
      return operationName === 'reset' ? method() : method(exactScope);
    },
    {
      key: E2E_CLAUDE_QUERY_PRELUDE_KEY,
      operationName: operation,
      exactScope: scope,
    },
  );
}

export function armClaudeQueryPrelude(electronApp, scope) {
  return useControl(electronApp, 'arm', scope);
}

export function readClaudeQueryPreludeState(electronApp, scope) {
  return useControl(electronApp, 'read', scope);
}

export function resetClaudeQueryPreludes(electronApp) {
  return useControl(electronApp, 'reset');
}
