import type {
  ScriptAction,
  ScriptActionsSnapshot,
} from '@canopy/protocol/script-actions';

export function scriptAction(
  id: string,
  overrides: Partial<ScriptAction> = {},
): ScriptAction {
  return {
    id,
    kind: 'detected',
    name: id,
    command: `pnpm run ${id}`,
    multiline: false,
    repoId: 'web',
    repoName: 'web',
    packagePath: null,
    target: { kind: 'repository', repoId: 'web' },
    source: { kind: 'package-json', file: 'package.json', entry: id, line: 1 },
    revision: `${id}-v1`,
    status: 'approved',
    shortcut: null,
    pinned: false,
    ...overrides,
  };
}

export function scriptSnapshot(
  actions: ScriptAction[],
  pendingCount = actions.filter((action) => action.status === 'pending').length,
): ScriptActionsSnapshot {
  return {
    actions,
    pendingCount,
    shellAliasScanEnabled: false,
    scanStatus: 'complete',
    scannedAt: null,
    diagnostics: [],
  };
}
