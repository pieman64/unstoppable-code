/**
 * @jest-environment node
 */
// Source-level coverage keeps this regression independent of the composer's
// many browser integrations. The Electron spec covers the real navigation
// flow and verifies the rendered mode transition.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(__dirname, '..', 'HomeComposerControls.tsx'),
  'utf-8',
);

describe('HomeComposerControls approval default', () => {
  it('does not present Ask before the selected project default resolves', () => {
    expect(SOURCE).not.toContain(
      "approvalMode ?? approvalDefaultForWorkspace ?? 'ask'",
    );
    expect(SOURCE).toContain('data-testid="home-approval-mode-loading"');
    expect(SOURCE).toContain('<LoadingSpinner decorative');
    expect(SOURCE).toContain(
      'approvalDefaultSelectionRef.current.workspaceId !== workspaceId',
    );
    expect(SOURCE).toContain(
      'requestId: approvalDefaultSelectionRef.current.requestId + 1',
    );
    expect(SOURCE).toContain(
      'approvalDefaultLookupResult?.requestId === approvalDefaultRequestId',
    );
    expect(SOURCE).toContain(
      'approvalDefaultLookupResult?.generation === approvalDefaultsGeneration',
    );
    expect(SOURCE).toContain('subscribeApprovalDefaultsGeneration');
    expect(SOURCE).toContain('approvalDefaultsGeneration,');
  });
});
