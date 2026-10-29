// CAN-3488: real shared dialog -> repair chat -> analyzer/tool persistence ->
// original receipt -> fresh dialog. The scripted agent supplies actions only;
// every blocked/ready result comes from the production dependency analyzer.
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  registerShareMembership,
  seedWorkspaceApprovals,
  writeJson,
  SHARE_MEMBERSHIP_TEAM,
} from './seeders/index.mjs';
import {
  seedChatSkillShare,
  connectChatShareAccount,
  SHARE_SKILL,
  SHARE_WORKSPACE,
  SHARE_WORKTREE,
} from './seeders/chatSkillShare.mjs';
import {
  clearPipelineShareSecurityAndFrontmatterProblems,
  seedPipelineShareUnresolvedInvocations,
  UNRESOLVED_INVOCATION_PIPELINE_ID,
} from './seeders/seedPipelineShareUnresolvedInvocations.mjs';
import { readChatStorageTabs } from './readChatStorage.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

function repairChats(userDataDir) {
  const root = path.join(userDataDir, 'workspaces', 'cowork-default');
  const manifests = path.join(root, 'chat-storage-manifests');
  if (!existsSync(manifests)) return [];
  return readdirSync(manifests)
    .filter((file) => file.endsWith('.json'))
    .flatMap((file) => {
      try {
        return readChatStorageTabs(root, file.slice(0, -5)).tabs;
      } catch {
        return [];
      }
    })
    .filter((tab) => JSON.stringify(tab.messages).includes('Sharing my '));
}

for (const kind of ['pipeline', 'skill', 'project']) {
  test(`${kind} dependency repair retains the original tile and reopens fresh analysis without publishing`, async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), `can3488-${kind}-`));
    seedChatSkillShare(userDataDir);
    seedPipelineShareUnresolvedInvocations(userDataDir);
    clearPipelineShareSecurityAndFrontmatterProblems(userDataDir);
    const pipelineIndex = JSON.parse(
      readFileSync(path.join(userDataDir, 'pipelines', 'index.json'), 'utf8'),
    );
    const uiKind = kind === 'skill' ? 'skill' : 'pipeline';
    const name =
      kind === 'project'
        ? 'Project Dependency Repair'
        : kind === 'skill'
          ? SHARE_SKILL
          : pipelineIndex.pipelines.find(
              (row) => row.id === UNRESOLVED_INVOCATION_PIPELINE_ID,
            ).name;
    if (kind === 'skill')
      writeFileSync(
        path.join(userDataDir, 'skills', 'custom:app', SHARE_SKILL, 'SKILL.md'),
        `---\nname: ${SHARE_SKILL}\ndescription: Repair the requested changes\n---\nRun /repair-diffs to repair the requested changes.\n`,
      );
    const projectRoot = path.join(
      userDataDir,
      'workspaces',
      SHARE_WORKSPACE,
      'worktrees',
      SHARE_WORKTREE,
    );
    const relativePath = '.canopy/pipelines/repair.yml';
    const projectFile = path.join(projectRoot, relativePath);
    const projectYaml = `name: ${name}\ndescription: Repair the current diff\non: dispatch\njobs:\n  repair:\n    steps:\n      - id: inspect\n        uses: builtin/agent-prompt\n        with:\n          model: sonnet\n          prompt: Run /repair-diffs.\n`;
    if (kind === 'project') {
      mkdirSync(path.dirname(projectFile), { recursive: true });
      writeFileSync(projectFile, projectYaml);
      seedWorkspaceApprovals({
        userDataDir,
        workspaceId: SHARE_WORKSPACE,
        defaultMode: 'full-access',
      });
    }
    writeJson(path.join(userDataDir, 'preferences.json'), {
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        defaultWorktreeProvider: 'claude',
        defaultChatProvider: 'claude',
        defaultChatInterfaceMode: 'canopy',
        defaultWorktreeModelByProvider: {
          claude: { model: 'sonnet', thinkingLevel: 'off' },
        },
      },
    });
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: 'cowork-default',
      defaultMode: 'full-access',
    });
    const subject =
      kind === 'skill'
        ? { kind: 'skill', sourceId: 'custom:app', skillName: SHARE_SKILL }
        : kind === 'project'
          ? {
              kind: 'project-pipeline',
              pipelineId: 'project--repair.yml',
              worktreeId: SHARE_WORKTREE,
              relativePath,
            }
          : {
              kind: 'user-pipeline',
              pipelineId: UNRESOLVED_INVOCATION_PIPELINE_ID,
            };
    const analyze = {
      type: 'capability_package.analyze',
      subject,
      context: {
        dismissedInvocations: [],
        ...(kind === 'project'
          ? { worktree: { worktreeId: SHARE_WORKTREE } }
          : {}),
      },
    };
    let toolSequence = 0;
    const toolStep = (action) => ({
      toolCalls: [
        {
          id: `can3488-${kind}-${++toolSequence}`,
          name: 'mcp__canopy__DispatchAction',
          input: { action },
        },
      ],
      stopReason: 'tool_use',
    });
    const firstLine = `Sharing my ${uiKind} "${name}" is blocked by dependency problems. Help me fix them so I can share it.`;
    const scenarioKey = `prompt:${firstLine}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, scenarioKey, {
      llm: {
        steps: [
          toolStep(analyze),
          toolStep({
            type: 'skills.create_custom',
            name: 'repair-diffs',
            description: 'Repair the requested changes',
            body: '# Repair diffs\nInspect the current diff, apply the requested corrections, and run the relevant checks.\n',
          }),
          ...(kind === 'project'
            ? [
                {
                  toolCalls: [
                    {
                      id: 'can3488-project-read',
                      name: 'Read',
                      input: { file_path: projectFile },
                    },
                  ],
                  stopReason: 'tool_use',
                },
                {
                  toolCalls: [
                    {
                      id: 'can3488-project-edit',
                      name: 'Edit',
                      input: {
                        file_path: projectFile,
                        old_string: 'prompt: Run /repair-diffs.',
                        new_string:
                          'prompt: Run /repair-diffs on the current diff.',
                      },
                    },
                  ],
                  stopReason: 'tool_use',
                },
              ]
            : []),
          toolStep(analyze),
          {
            text: 'Dependency check complete. Use the original item tile to review sharing.',
            stopReason: 'end_turn',
          },
        ],
      },
    });
    const apiKey = `csk_can3488_${kind}`;
    await registerShareMembership(apiKey);
    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await connectChatShareAccount(window, apiKey);
      if (kind === 'project') {
        await app.openMainPage();
        await app.selectWorktree(SHARE_WORKTREE, {
          expandDefaultActivityRail: false,
        });
      }
      if (kind !== 'skill') {
        await app.openPipelinesPage();
        await app.openWorkflowsLibraryRow(
          app.workflowsLibraryPipelineRow(
            kind === 'project'
              ? projectFile
              : UNRESOLVED_INVOCATION_PIPELINE_ID,
            kind === 'project' ? 'project' : 'user',
          ),
        );
        await window
          .getByTestId('workflow-edit-actions')
          .getByTestId('pipeline-share')
          .click();
      } else {
        await app.openPluginsPage();
        await app.openPluginsTab('skills');
        await window
          .getByTestId(`skill-share-custom:app-${SHARE_SKILL}`)
          .click();
      }
      const review = window.getByTestId(`share-${uiKind}-dependencies`);
      await expect(review).toHaveAttribute('data-state', 'blocked', {
        timeout: 30_000,
      });
      await window
        .getByTestId(
          `share-${uiKind}-team-picker-option-${SHARE_MEMBERSHIP_TEAM.id}`,
        )
        .click();
      await window
        .getByTestId(`share-${uiKind}-dependency-problems-fix-with-ai`)
        .click();
      await expect(window.getByTestId(`share-${uiKind}-modal`)).toHaveCount(0);
      await expect(
        window.getByText(
          'Dependency check complete. Use the original item tile to review sharing.',
          { exact: true },
        ),
      ).toBeVisible({ timeout: 90_000 });
      const chats =
        kind === 'project'
          ? readChatStorageTabs(
              path.join(userDataDir, 'workspaces', SHARE_WORKSPACE),
              SHARE_WORKTREE,
            ).tabs.filter((tab) =>
              JSON.stringify(tab.messages).includes('Sharing my pipeline'),
            )
          : repairChats(userDataDir);
      if (kind === 'project') {
        expect(repairChats(userDataDir)).toHaveLength(0);
        expect(readFileSync(projectFile, 'utf8')).toBe(
          projectYaml.replace(
            'prompt: Run /repair-diffs.',
            'prompt: Run /repair-diffs on the current diff.',
          ),
        );
        expect(JSON.stringify(chats)).toContain(relativePath);
      }
      expect(chats).toHaveLength(1);
      if (kind === 'skill')
        expect(chats[0].pluginSelections?.skillRefs).toContainEqual({
          sourceId: 'custom:app',
          skillName: SHARE_SKILL,
        });
      const serialized = JSON.stringify(chats[0].messages);
      const blocks = chats[0].messages.flatMap(
        (message) => message.blocks ?? [],
      );
      expect(
        blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n'),
      ).toContain(firstLine);
      expect(serialized).toContain(SHARE_MEMBERSHIP_TEAM.name);
      expect(serialized).toContain('/repair-diffs');
      const calls = blocks
        .filter(
          (block) =>
            block.type === 'tool_use' &&
            block.toolName === 'mcp__canopy__DispatchAction',
        )
        .map((block) => ({ ...block, parsed: JSON.parse(block.input) }));
      const analyses = calls.filter(
        (block) => block.parsed.action?.type === 'capability_package.analyze',
      );
      expect(analyses).toHaveLength(2);
      const outcomes = analyses.map((call) =>
        JSON.parse(
          blocks.find(
            (block) =>
              block.type === 'tool_result' &&
              block.toolUseId === call.toolUseId,
          ).output,
        ),
      );
      expect(
        outcomes.map((result) => result.result.state),
        JSON.stringify(blocks.filter((block) => block.type === 'tool_result')),
      ).toEqual(['blocked', 'ready']);
      expect(outcomes.every((result) => result.ok)).toBe(true);
      if (kind === 'project')
        expect(
          analyses.every(
            (call) =>
              call.parsed.action.subject.worktreeId === SHARE_WORKTREE &&
              call.parsed.action.subject.relativePath === relativePath,
          ),
        ).toBe(true);
      expect(
        calls.some((call) =>
          [
            'pipeline.share',
            'skills.share_custom',
            'sharing.open_dialog',
          ].includes(call.parsed.action?.type),
        ),
      ).toBe(false);
      // The analysis emits the original item even though only its dependency
      // was created. Choose by the accessible item identity, not receipt order.
      await window
        .getByRole('button', { name: `Share ${name}`, exact: true })
        .last()
        .click();
      await expect(review).toHaveAttribute('data-state', 'ready', {
        timeout: 30_000,
      });
      await expect(window.getByTestId(`share-${uiKind}-modal`)).toBeVisible();
      const activity = await (
        await fetch(
          `${DEFAULT_MOCK_BASE_URL}/__mock/activity/${encodeURIComponent(apiKey)}`,
        )
      ).json();
      expect(activity.activity.capabilityPublicationRequests ?? 0).toBe(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
