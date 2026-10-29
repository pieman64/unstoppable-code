/**
 * CAN-2552 durable recipient fork coverage.
 *
 * Walks the flow a recipient actually takes: accept a Cowork share, open its
 * row menu, make a copy, pass the disclosures, and land in the copy. Cowork is
 * the container type chosen here because its fork is entirely local file work
 * with no git host, clone, or credentials, so the spec exercises the real
 * main-process fork engine end to end rather than a stub.
 *
 * The assertions that matter are the ones a refactor can silently break:
 *
 * - The disclosures are a gate, not decoration. Reaching the confirm control
 *   requires passing the destination step first.
 * - The source replica survives the fork. Copy-never-move is the invariant the
 *   whole fork design rests on, and a fork that moved the tree would still
 *   look successful from the destination's side.
 * - The copy is an ordinary local container. It lands on the chat page as a
 *   Work Entry, not back in "Shared with me".
 *
 * Run: pnpm run test:electron:built can-2552-shared-container-fork.spec.mjs --reporter=line
 */
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { acceptSharedContainerInvitation } from './sharedContainerRecipientActions.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedCoworkWorkspace,
  seedOrgContextScoping,
  seedSharedContainerRecipientReplicas,
  sharedContainerRecipientScenario,
  ORG_CONTEXT_ENV,
  SHARED_CONTAINER_RECIPIENT_COWORK_ID,
  SHARED_CONTAINER_RECIPIENT_CODE_ID,
} from './seeders/index.mjs';
import {
  OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
  SHARED_CONTAINERS_CLOUD_API_KEY,
  SHARED_CONTAINERS_ORGANIZATION_ID,
  buildSharedContainerE2eEnv,
  connectSharedContainersAccount,
} from './sharedContainerInviteFixture.mjs';
import { selectWorkspaceContext } from './workspaceContextMenu.mjs';

test.describe.configure({ mode: 'serial' });

test('copies an accepted Cowork share into an independent local project', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-fork-'),
  );
  const recipientScenario = sharedContainerRecipientScenario({
    includeRun: false,
  });
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    recipientScenario,
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const loginWindow = await electronApp.firstWindow();
    await connectSharedContainersAccount(loginWindow);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    // Seed only after the identity transition, then restart so the production
    // replica manager binds the injected fixture's filesystem identity before
    // it performs any destructive operation such as recipient dismissal.
    seedSharedContainerRecipientReplicas(userDataDir, {
      preferences: false,
      includeRun: false,
    });
    // A pre-existing Cowork workspace is the real-world precondition for the
    // bug this spec guards: the recipient has used Cowork before forking, so
    // the store's `chatProjects` is already populated and stale rather than
    // unloaded. It also gets the chat page past `StandaloneChatPage`'s
    // `isColdStart` branch, which returns a `page-chat` section holding only
    // `StandaloneColdStartEmptyState` and never reaches `CoworkTopBar` — and
    // `cowork-top-bar` visibility is this spec's "initialize finished" signal.
    seedCoworkWorkspace({ userDataDir, collapsed: false });
    const sourceRevisionRoot = path.join(
      userDataDir,
      'shared-containers',
      SHARED_CONTAINER_RECIPIENT_COWORK_ID,
      'revisions',
      'cowork-revision-1',
    );
    const publishedChatPath = path.join(
      sourceRevisionRoot,
      'artifacts',
      'chats',
      'cowork-chat.json',
    );
    const publishedChat = JSON.parse(readFileSync(publishedChatPath, 'utf8'));
    publishedChat.messages[0].parts = [
      {
        kind: 'attachment',
        data: { references: [{ displayPath: '/etc/passwd' }] },
      },
    ];
    writeFileSync(publishedChatPath, JSON.stringify(publishedChat), 'utf8');
    const publishedLayoutPath = path.join(
      sourceRevisionRoot,
      'artifacts',
      'container.json',
    );
    const publishedLayout = JSON.parse(
      readFileSync(publishedLayoutPath, 'utf8'),
    );
    const sharedClaudeInstructions = 'Use the shared customer workflow.\n';
    const sharedAgentsInstructions =
      'Use the distinct shared agent instructions.\n';
    publishedLayout.files.push(
      {
        path: 'CLAUDE.md',
        status: 'added',
        artifactId: 'cowork-claude-md',
        sizeBytes: String(Buffer.byteLength(sharedClaudeInstructions)),
      },
      {
        path: 'AGENTS.md',
        status: 'added',
        artifactId: 'cowork-agents-md',
        sizeBytes: String(Buffer.byteLength(sharedAgentsInstructions)),
      },
    );
    writeFileSync(publishedLayoutPath, JSON.stringify(publishedLayout), 'utf8');
    writeFileSync(
      path.join(sourceRevisionRoot, 'content', 'CLAUDE.md'),
      sharedClaudeInstructions,
      'utf8',
    );
    writeFileSync(
      path.join(sourceRevisionRoot, 'content', 'AGENTS.md'),
      sharedAgentsInstructions,
      'utf8',
    );
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    // Visit the chat page first so `StandaloneChatPage` mounts and the store
    // reaches `initialized: true` with a populated `chatProjects`. Without
    // this, `openWorkEntryFromSidebar` takes its cold-`initialize()` branch,
    // which re-lists as a side effect and accidentally hides the bug. Waiting
    // on `cowork-top-bar` rather than `page-chat` is what proves `initialize()`
    // finished, not merely that the page rendered.
    await app.openChatPage();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 30_000,
    });
    await app.openMainPage();
    await expect(
      window.getByTestId('sidebar-section-shared-with-me'),
    ).toBeVisible({ timeout: 30_000 });

    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_COWORK_ID,
    );
    const coworkRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}`,
    );
    await expect(coworkRow).toBeVisible({ timeout: 30_000 });

    await coworkRow.hover();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-actions`,
      )
      .click();
    const forkItem = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-fork`,
    );
    // Only a readable replica has a revision to copy from; the row asks main
    // for that before enabling the action.
    await expect(forkItem).toBeEnabled({ timeout: 30_000 });
    // Entry point and dialog share one word for one concept.
    await expect(forkItem).toContainText('Make a copy');
    await forkItem.click();

    const modal = window.getByTestId('shared-container-fork-modal');
    await expect(modal).toBeVisible();
    await expect(
      window.getByTestId('shared-container-fork-destination'),
    ).toBeVisible();
    // A Cowork copy has no repositories to place, so the clone-directory field
    // must not appear at all.
    await expect(
      window.getByTestId('shared-container-fork-location'),
    ).toHaveCount(0);
    // The disclosures gate the fork: there is no confirm control until the
    // destination step has been passed.
    await expect(
      window.getByTestId('shared-container-fork-confirm'),
    ).toHaveCount(0);

    await window.getByTestId('shared-container-fork-continue').click();
    const disclosures = window.getByTestId('shared-container-fork-disclosures');
    await expect(disclosures).toBeVisible();
    await expect(disclosures).toContainText('never picks up');
    await expect(disclosures).toContainText('cannot take the copy back');
    await expect(disclosures).toContainText('not a conversation you can pick');

    // CAN-3710: the copy opens as soon as it is made; no done screen.
    await window.getByTestId('shared-container-fork-confirm').click();
    await expect(modal).toHaveCount(0, { timeout: 60_000 });

    // The copy is an ordinary Cowork Work Entry on the chat page. Its durable
    // provenance remains visible after the success dialog is gone.
    await expect(window.getByTestId('page-chat')).toBeVisible({
      timeout: 30_000,
    });
    await window
      .getByTestId('page-chat')
      .getByTestId('panel-tab-panel-chat-cowork-chat')
      .click();
    // Scoped to the copy: the share viewer stays mounted in the background and
    // renders the same published chat.
    await expect(
      window
        .getByTestId('page-chat')
        .getByText('Summarize the customer follow-up.', { exact: false }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(window.getByText('/etc/passwd', { exact: false })).toHaveCount(
      0,
    );
    await expect(
      window.getByTestId('shared-container-fork-provenance'),
    ).toContainText('does not update when theirs does');
    // The notice above is keyed on (activeChatProjectId, activeWorkEntryId) and
    // renders null on a miss, so it is already a selection assertion. These two
    // name the selection, so it cannot pass with the wrong workspace active.
    await expect(window.getByTestId('cowork-top-workspace-name')).toHaveText(
      'Customer follow-up',
    );
    // Scope to the panel: the sidebar row carries this same string, which is
    // precisely why the pre-open assertion passes while the row is dead.
    await expect(
      window
        .getByTestId('page-chat')
        .getByTestId('panel-content-chat')
        .filter({ hasText: 'Summarize the customer follow-up.' }),
    ).toBeVisible();

    const workspaceIndex = JSON.parse(
      readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
    );
    const forkWorkspace = workspaceIndex.workspaces.find(
      (workspace) => workspace.name === 'Customer follow-up',
    );
    expect(forkWorkspace).toBeTruthy();
    const workEntries = JSON.parse(
      readFileSync(
        path.join(
          userDataDir,
          'workspaces',
          forkWorkspace.id,
          'work-entries.json',
        ),
        'utf8',
      ),
    );
    expect(workEntries.entries).toHaveLength(1);

    // Symptom 2 of the reported bug: the forked row rendered but clicking it
    // did nothing, permanently. The row reads `workEntries.list` directly, so
    // it renders regardless of whether the Cowork store ever listed the
    // workspace — navigate away and come back through the row itself.
    const forkedEntryRow = window
      .locator(
        `[data-testid="sidebar-work-entry-${workEntries.entries[0].id}"]`,
      )
      .first();
    await app.openMainPage();
    await expect(window.getByTestId('page-chat')).toHaveCount(0);
    await expect(forkedEntryRow).toBeVisible({ timeout: 30_000 });
    await forkedEntryRow.click();
    await expect(window.getByTestId('page-chat')).toBeVisible({
      timeout: 30_000,
    });
    await expect(forkedEntryRow).toHaveAttribute(
      'data-sidebar-selected-item',
      '',
      { timeout: 30_000 },
    );
    await expect(window.getByTestId('cowork-top-workspace-name')).toHaveText(
      'Customer follow-up',
    );
    const managedRoot = path.join(
      userDataDir,
      'workspaces',
      forkWorkspace.id,
      'home',
      '.canopy',
    );
    expect(readdirSync(path.join(managedRoot, 'notes'))).toEqual([
      expect.stringMatching(/^cowork-note-[a-f0-9]{12}\.md$/),
    ]);
    expect(readdirSync(path.join(managedRoot, 'prompts'))).toEqual([
      expect.stringMatching(/^cowork-prompt-[a-f0-9]{12}\.md$/),
    ]);
    const forkedFile = path.join(
      userDataDir,
      'workspaces',
      forkWorkspace.id,
      'home',
      'exports',
      'customer-summary.txt',
    );
    expect(readFileSync(forkedFile, 'utf8')).toBe(
      'Customer follow-up details.\n',
    );
    const forkHome = path.dirname(path.dirname(forkedFile));
    expect(readFileSync(path.join(forkHome, 'CLAUDE.md'), 'utf8')).toBe(
      sharedClaudeInstructions,
    );
    const forkAgentsPath = path.join(forkHome, 'AGENTS.md');
    expect(lstatSync(forkAgentsPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(forkAgentsPath, 'utf8')).toBe(sharedAgentsInstructions);
    expect(existsSync(sourceRevisionRoot)).toBe(true);

    // Removing the source acceptance purges its replica but cannot recall or
    // reconnect the local fork. It remains writable afterwards.
    await app.openMainPage();
    await expect(coworkRow).toBeVisible();
    await coworkRow.hover();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-actions`,
      )
      .click();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-remove`,
      )
      .click();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_COWORK_ID}-remove-confirm`,
      )
      .click();
    await expect(coworkRow).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(() => existsSync(sourceRevisionRoot), { timeout: 30_000 })
      .toBe(false);

    writeFileSync(forkedFile, 'Edited after source removal.\n', 'utf8');
    expect(readFileSync(forkedFile, 'utf8')).toBe(
      'Edited after source removal.\n',
    );
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

test('copies a code snapshot with its commit and overlay state', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-code-fork-'),
  );
  const recipientScenario = sharedContainerRecipientScenario({
    includeCowork: false,
    includeRun: false,
    codeSource: 'snapshot',
  });
  const agentReply = 'Mock response from the Canopy UI-automation LLM surface.';
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    recipientScenario,
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const loginWindow = await electronApp.firstWindow();
    await connectSharedContainersAccount(loginWindow);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    seedSharedContainerRecipientReplicas(userDataDir, {
      preferences: false,
      includeRun: false,
      codeSource: 'snapshot',
    });
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const sourceRevisionRoot = path.join(
      userDataDir,
      'shared-containers',
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
      'revisions',
      'code-revision-1',
    );
    const sourceLayout = JSON.parse(
      readFileSync(
        path.join(sourceRevisionRoot, 'artifacts', 'container.json'),
        'utf8',
      ),
    );
    expect(sourceLayout.schemaVersion).toBe(2);
    expect(sourceLayout.repositories[0].source).toBe('snapshot');
    const sourceStatusBefore = Object.fromEntries(
      sourceLayout.repositories.map((repository) => [
        repository.repoId,
        execFileSync('git', ['status', '--short'], {
          cwd: path.join(sourceRevisionRoot, 'repos', repository.repoId),
          encoding: 'utf8',
        }),
      ]),
    );

    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
    );
    const codeRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
    );
    await expect(codeRow).toBeVisible({ timeout: 30_000 });
    await codeRow.hover();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}-actions`,
      )
      .click();
    const forkItem = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}-fork`,
    );
    await expect(forkItem).toBeVisible({ timeout: 30_000 });
    await forkItem.click();

    await expect(
      window.getByTestId('shared-container-fork-location'),
    ).not.toHaveValue('');
    await window.getByTestId('shared-container-fork-continue').click();
    await window.getByTestId('shared-container-fork-confirm').click();
    await expect(window.getByTestId('page-main')).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      window.getByTestId('shared-container-fork-provenance'),
    ).toContainText('does not update when theirs does');

    const workspaceIndex = JSON.parse(
      readFileSync(path.join(userDataDir, 'workspaces', 'index.json'), 'utf8'),
    );
    const workspace = workspaceIndex.workspaces.find(
      (item) => item.name === 'Recipient feature branch',
    );
    expect(workspace).toBeTruthy();
    const workspaceDir = path.join(userDataDir, 'workspaces', workspace.id);
    const config = JSON.parse(
      readFileSync(path.join(workspaceDir, 'workspace.json'), 'utf8'),
    );
    const worktrees = JSON.parse(
      readFileSync(path.join(workspaceDir, 'worktrees.json'), 'utf8'),
    );
    expect(config.type).toBe('multi-repo');
    expect(config.repos).toHaveLength(2);
    expect(worktrees.worktrees).toHaveLength(1);
    const worktreeId = worktrees.worktrees[0].id;
    for (const publishedRepo of sourceLayout.repositories) {
      const localRepo = config.repos.find(
        (repo) => repo.name === publishedRepo.repoName,
      );
      expect(localRepo).toBeTruthy();
      // The promoted checkout is the workspace source repository. Published
      // overlay state belongs only in the new worktree below, never here.
      expect(
        execFileSync('git', ['status', '--short', '--untracked-files=all'], {
          cwd: localRepo.repoPath,
          encoding: 'utf8',
        }),
      ).toBe('');
      const checkout = path.join(
        workspaceDir,
        'worktrees',
        worktreeId,
        'repos',
        localRepo.id,
      );
      expect(
        execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: checkout,
          encoding: 'utf8',
        }).trim(),
      ).toBe(publishedRepo.baseCommitSha);
      const status = execFileSync(
        'git',
        ['status', '--short', '--untracked-files=all'],
        {
          cwd: checkout,
          encoding: 'utf8',
        },
      );
      const overlayPath =
        publishedRepo.repoId === 'repo-1'
          ? 'src/recipient.ts'
          : 'src/secondary.ts';
      expect(status).toContain(`?? ${overlayPath}`);
      expect(readFileSync(path.join(checkout, overlayPath), 'utf8')).toContain(
        'true',
      );
      if (publishedRepo.repoId === 'repo-1') {
        // CAN-2552: a committed symlink (git mode 120000) is ordinary content
        // — Canopy's own tree has one — and the fork used to refuse the whole
        // copy on sight. It must arrive as a link, not as a copy of its
        // target, and the checkout must stay clean because of it.
        const committedLink = path.join(checkout, 'skills', 'committed-link');
        expect(lstatSync(committedLink).isSymbolicLink()).toBe(true);
        expect(readlinkSync(committedLink, 'utf8')).toBe(
          '../src/committed-change.ts',
        );
        expect(status).not.toContain('skills/committed-link');
      }
      expect(
        execFileSync('git', ['status', '--short'], {
          cwd: path.join(sourceRevisionRoot, 'repos', publishedRepo.repoId),
          encoding: 'utf8',
        }),
      ).toBe(sourceStatusBefore[publishedRepo.repoId]);
    }

    // A local workspace was created, but the cloud listing still contains
    // only the original share. No grant or shared-container row was copied.
    await app.openMainPage();
    await expect(codeRow).toBeVisible();

    await codeRow.hover();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}-actions`,
      )
      .click();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}-remove`,
      )
      .click();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}-remove-confirm`,
      )
      .click();
    await expect(codeRow).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(() => existsSync(sourceRevisionRoot), { timeout: 30_000 })
      .toBe(false);

    const firstRepo = config.repos.find(
      (repo) => repo.name === sourceLayout.repositories[0].repoName,
    );
    expect(firstRepo).toBeTruthy();
    const firstCheckout = path.join(
      workspaceDir,
      'worktrees',
      worktreeId,
      'repos',
      firstRepo.id,
    );
    const independentFile = path.join(firstCheckout, 'after-revocation.txt');
    writeFileSync(independentFile, 'still local\n', 'utf8');
    execFileSync('git', ['add', 'after-revocation.txt'], {
      cwd: firstCheckout,
    });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Recipient Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--quiet',
        '--no-gpg-sign',
        '-m',
        'edit independent fork',
      ],
      { cwd: firstCheckout },
    );
    expect(readFileSync(independentFile, 'utf8')).toBe('still local\n');

    const chatPanel = window.getByTestId('panel-content-chat');
    const composer = chatPanel.getByRole('textbox').first();
    await composer.fill('Confirm this local fork still works.');
    await chatPanel.getByRole('button', { name: 'Send message' }).click();
    await expect(chatPanel.getByText(agentReply).first()).toBeVisible({
      timeout: 90_000,
    });
    const activity = await getScenarioActivity(
      DEFAULT_MOCK_BASE_URL,
      SHARED_CONTAINERS_CLOUD_API_KEY,
    );
    expect(activity.activity.sharedContainersDismiss).toBe(1);
    expect(activity.activity.sharedContainersCreate ?? 0).toBe(0);
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});

test('filters existing-project fork destinations to the share owning context', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-shared-container-context-fork-'),
  );
  const organizations = [
    {
      id: SHARED_CONTAINERS_ORGANIZATION_ID,
      name: 'Share owner org',
      role: 'MEMBER',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
      name: 'Other org',
      role: 'MEMBER',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  const recipientScenario = sharedContainerRecipientScenario({
    includeCowork: false,
    includeRun: false,
  });
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    SHARED_CONTAINERS_CLOUD_API_KEY,
    {
      ...recipientScenario,
      cloud: {
        ...(recipientScenario.cloud ?? {}),
        organizations,
        orgBillingStates: organizations.map((organization) => ({
          organizationId: organization.id,
          organizationName: organization.name,
          teamsEntitled: true,
        })),
      },
    },
  );

  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir),
    }));
    const loginWindow = await electronApp.firstWindow();
    await connectSharedContainersAccount(loginWindow);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;

    seedSharedContainerRecipientReplicas(userDataDir, {
      preferences: false,
      includeCowork: false,
      includeRun: false,
    });
    seedOrgContextScoping(userDataDir, {
      extraPersonalWorkspaces: [
        { id: 'context-other-org', name: 'Other organization repository' },
      ],
    });
    for (const [workspaceId, organizationId, projectId, instanceId] of [
      [
        'context-organization',
        SHARED_CONTAINERS_ORGANIZATION_ID,
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
      ],
      [
        'context-other-org',
        OTHER_SHARED_CONTAINERS_ORGANIZATION_ID,
        '55555555-5555-4555-8555-555555555555',
        '66666666-6666-4666-8666-666666666666',
      ],
    ]) {
      const configPath = path.join(
        userDataDir,
        'workspaces',
        workspaceId,
        'workspace.json',
      );
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            ...config,
            owner: {
              type: 'organization',
              organizationId,
              projectId,
              instanceId,
              bindingGeneration: 0,
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
    }
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: buildSharedContainerE2eEnv(userDataDir, {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS:
          ORG_CONTEXT_ENV.CANOPY_E2E_CLIENT_FEATURE_FLAGS,
        CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT: 'off',
      }),
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await selectWorkspaceContext(window, SHARED_CONTAINERS_ORGANIZATION_ID);
    await app.openMainPage();

    await acceptSharedContainerInvitation(
      window,
      SHARED_CONTAINER_RECIPIENT_CODE_ID,
    );
    const codeRow = window.getByTestId(
      `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}`,
    );
    await expect(codeRow).toBeVisible({ timeout: 30_000 });
    await codeRow.hover();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}-actions`,
      )
      .click();
    await window
      .getByTestId(
        `shared-container-row-${SHARED_CONTAINER_RECIPIENT_CODE_ID}-fork`,
      )
      .click();

    await window
      .getByTestId('shared-container-fork-destination-existing')
      .click();
    const select = window.getByTestId('shared-container-fork-workspace');
    await expect(select).toHaveValue('');
    await expect(select.locator('option').first()).toHaveText(
      'Choose a project',
    );
    await expect(select).toContainText('Acme repository');
    await expect(select).not.toContainText('Personal repository');
    await expect(select).not.toContainText('Other organization repository');
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      await clearScenario(
        DEFAULT_MOCK_BASE_URL,
        SHARED_CONTAINERS_CLOUD_API_KEY,
      ).catch(() => undefined);
    }
  }
});
