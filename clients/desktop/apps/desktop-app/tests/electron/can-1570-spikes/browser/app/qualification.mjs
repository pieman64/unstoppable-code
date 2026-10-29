const SKIP_KEYS = new Set([
  'rawCommands',
  'rawDebuggerEvents',
  'rawDragEvents',
  'rawInputCommands',
  'evidence',
  'commands',
  'events',
  'commandResults',
]);
const MAX_FAILURES = 50;
const MAX_DETAIL_LENGTH = 300;

function detailOf(value) {
  const detail =
    typeof value === 'string'
      ? value
      : typeof value?.error === 'string'
        ? value.error
        : typeof value?.reason === 'string'
          ? value.reason
          : (JSON.stringify(value) ?? String(value));
  return detail.slice(0, MAX_DETAIL_LENGTH);
}

/**
 * Qualification checks harness execution markers, not CDP command errors or
 * expected contextBridge setup timeouts, which are protocol observations.
 */
export function collectExecutionFailures(spikes) {
  const failures = [];
  const record = (path, value) => {
    if (failures.length < MAX_FAILURES)
      failures.push({ path, detail: detailOf(value) });
  };
  const visit = (value, path) => {
    if (failures.length >= MAX_FAILURES || !value || typeof value !== 'object')
      return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (typeof value.kind === 'string' && /-error$/.test(value.kind))
      record(path, value);
    for (const [key, child] of Object.entries(value)) {
      if (failures.length >= MAX_FAILURES) break;
      if (SKIP_KEYS.has(key)) continue;
      if (key === 'setupErrors' && path.endsWith('.contextBridge')) continue;
      const childPath = path ? `${path}.${key}` : key;
      if (
        (key === 'errors' || key === 'sampleErrors') &&
        Array.isArray(child)
      ) {
        if (child.length) record(childPath, child[0]);
        continue;
      }
      if (key === 'oopifAttach' && child?.status === 'not-observed')
        record(childPath, child);
      if (key === 'findings' && child && !Array.isArray(child)) {
        for (const [findingKey, finding] of Object.entries(child)) {
          if (finding?.status === 'error')
            record(`${childPath}.${findingKey}`, finding);
        }
      }
      visit(child, childPath);
    }
  };
  visit(spikes, '');
  return failures;
}
