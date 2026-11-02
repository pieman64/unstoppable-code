// CAN-4153: host refusals become typed core.script.* codes.
jest.mock('../sidebar-items', () => ({ readAllSidebarItems: jest.fn() }));

import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { PortalServiceError } from '../../services/portal-service-error';
import { desktopScriptDefinitionsHost } from '../script-definition-host';
import { WorkspaceRepoNotFoundError } from '../source-layer-resolution';
import { W5RevisionConflictError } from '../w5-commit-log-file-store';
import { ScriptHookSettingsRefusedError } from '../workspace-script-hook-settings';

describe('desktopScriptDefinitionsHost.errorCode', () => {
  it.each([
    [new WorkspaceRepoNotFoundError('ws', 'gone'), 'core.script.notFound'],
    [
      new PortalServiceError('not_found', 'Project not found.'),
      'core.script.notFound',
    ],
    [
      new ScriptHookSettingsRefusedError('invalid-request', 'Invalid script.'),
      'core.script.invalidDefinition',
    ],
    [
      new ScriptHookSettingsRefusedError('read-only-scope', 'Read only.'),
      'core.script.readOnly',
    ],
    [
      new W5RevisionConflictError('workspace:ws', 1, 2),
      'core.script.revisionConflict',
    ],
    [
      new W5CommitRefusedError('key-reused', 'Used.'),
      'core.script.idempotencyKeyReused',
    ],
    [new Error('disk full'), undefined],
  ])('maps %p', (error, code) => {
    expect(desktopScriptDefinitionsHost.errorCode(error)).toBe(code);
  });

  it('keeps the legacy missing-repository message', () => {
    expect(new WorkspaceRepoNotFoundError('ws', 'gone').message).toBe(
      'Repo gone not found in project ws',
    );
  });
});
