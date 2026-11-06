// CAN-3233: current Cowork creation must remain independent of user Git policy.
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../agents/session-manager', () => ({}));
jest.mock('../pipelines/execution-runtime', () => ({}));
jest.mock('../ledger/lifecycle', () => ({}));

import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCoworkWorkspace,
  listCoworkWorkspacesAsChatProjects,
  updateCoworkWorkspace,
} from '../lib/cowork-workspace-crud';
import { getCoworkWorkspaceRootDir } from '../lib/paths';
import { __resetSidebarItemsStateForTests } from '../lib/sidebar-items';
import {
  loadChatProjectInstructions,
  saveChatProjectInstructions,
} from '../lib/chat-project-instructions';

interface GitFailureFixture {
  env: NodeJS.ProcessEnv;
  runControl(repo?: string): Promise<unknown>;
  readInvocations(): unknown[];
  readTrace(): string;
  assertPolicyUnchanged(): void;
}
const { GIT_FAILURE_CASES, createGitFailureFixture } = jest.requireActual<{
  GIT_FAILURE_CASES: string[];
  createGitFailureFixture: (
    root: string,
    scenario: string,
  ) => GitFailureFixture;
}>('../../../tests/electron/gitFailureFixture.js');

// The pre-migration standalone-chat seed commit was removed. This golden
// exercises its current production successor, including durable rediscovery.
// Linux runs every fixture; macOS also proves parity. POSIX scripts are not
// portable to Windows, whose existing Git readiness goldens remain separate.
const posixTest = process.platform === 'win32' ? test.skip : test;
posixTest.each(GIT_FAILURE_CASES)(
  'first Cowork stays usable under %s without changing user Git policy',
  async (scenario) => {
    const originalEnv = process.env;
    const root = await mkdtemp(join(tmpdir(), 'can-3233-unit-'));
    const fixture = createGitFailureFixture(join(root, 'git-policy'), scenario);
    process.env = {
      ...originalEnv,
      ...fixture.env,
      CANOPY_DATA_DIR: join(root, 'data'),
    };
    __resetSidebarItemsStateForTests();
    try {
      const trace = fixture.readTrace();
      const started = performance.now();
      const project = await createCoworkWorkspace('First project');
      // A test budget for the observable creation, not a new product timeout.
      expect(performance.now() - started).toBeLessThan(5000);
      const home = getCoworkWorkspaceRootDir(project.id);
      expect(existsSync(join(home, '.git'))).toBe(false);
      expect(fixture.readTrace()).toBe(trace);
      expect(fixture.readInvocations()).toEqual([]);
      const loaded = await loadChatProjectInstructions(home);
      expect(
        await saveChatProjectInstructions(home, {
          content: '# Still usable\n',
          revision: loaded.revision,
        }),
      ).toMatchObject({ status: 'saved' });
      expect((await loadChatProjectInstructions(home)).content).toBe(
        '# Still usable\n',
      );
      await updateCoworkWorkspace({ projectId: project.id, name: 'Renamed' });
      __resetSidebarItemsStateForTests();
      expect(
        await listCoworkWorkspacesAsChatProjects(undefined, {
          provisionDefaults: false,
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: project.id, name: 'Renamed' }),
        ]),
      );
      // Only the control initializes Git. An ordinary user commit in the same
      // folder must still encounter the configured hooks/signing/identity.
      await fixture.runControl(home);
      expect((await loadChatProjectInstructions(home)).content).toBe(
        '# Still usable\n',
      );
      fixture.assertPolicyUnchanged();
    } finally {
      process.env = originalEnv;
      __resetSidebarItemsStateForTests();
      try {
        fixture.assertPolicyUnchanged();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  15000,
);
