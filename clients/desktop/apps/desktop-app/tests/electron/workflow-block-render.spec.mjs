import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

// ---------------------------------------------------------------------------
// Workflow block rendering — receipt folded across messages.
//
// The `Workflow` tool runs in the background: its tool_use streams first and
// the launch receipt (tool_result) can land in a LATER persisted message, on a
// turn that already completed. `mergeToolResults`
// (`apps/desktop-app/src/renderer/src/components/chat/message-transforms.ts`)
// builds its result map across the whole transcript, pairs that late
// tool_result with the earlier tool_use, and `parseWorkflowBlock` parses the
// receipt into the `workflow` display block. `blocksMatch`
// (`incremental-turn-groups.ts`) must treat the folded receipt as meaningful
// content — a cached completed turn group that ignores it would render the
// card stale ("Launching workflow…" forever).
//
// This spec seeds exactly that transcript shape into a standalone chat
// (renders via `ChatContent` → `ChatMessageList` → `TurnGroupRenderer` →
// `ChatBlockRenderer` → `WorkflowBlock`) and asserts:
//   1. the workflow card renders once, with the name parsed from the script
//      and the receipt summary, and `data-launched="true"` (runId parsed);
//   2. the tool_result-only carrier message is folded away — it must not
//      render as a standalone message or generic tool block.
// ---------------------------------------------------------------------------

const T = Date.parse('2026-04-10T12:00:00.000Z');

const WORKFLOW_TOOL_USE_ID = 'toolu_workflow_1';

const WORKFLOW_SCRIPT =
  "export const meta = { name: 'nightly-review', description: 'Review changes' }";

const WORKFLOW_RECEIPT = [
  'Workflow launched in background.',
  'Task ID: task-001',
  'Run ID: wf_e2e-fixture',
  'Transcript dir: /nonexistent/wf-e2e-fixture',
  'Summary: 3 phases queued',
].join('\n');

function writeText(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, 'utf8');
}

// One completed turn whose assistant message holds the Workflow tool_use, then
// a separate later assistant message carrying ONLY the tool_result receipt —
// the cross-message folding shape.
function buildMessages() {
  return [
    {
      id: 'turn-1-user',
      role: 'user',
      blocks: [{ type: 'text', text: 'Run the nightly review workflow.' }],
      timestamp: T,
    },
    {
      id: 'turn-1-assistant',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'Launching the workflow now.' },
        {
          type: 'tool_use',
          toolUseId: WORKFLOW_TOOL_USE_ID,
          toolName: 'Workflow',
          input: JSON.stringify({ script: WORKFLOW_SCRIPT }),
        },
      ],
      timestamp: T + 5_000,
    },
    {
      id: 'turn-1-timer',
      role: 'system',
      blocks: [{ type: 'turn_timer', startedAt: T, completedAt: T + 6_000 }],
      timestamp: T + 6_000,
    },
    {
      id: 'late-workflow-receipt',
      role: 'assistant',
      blocks: [
        {
          type: 'tool_result',
          toolUseId: WORKFLOW_TOOL_USE_ID,
          toolName: 'Workflow',
          output: WORKFLOW_RECEIPT,
          isError: false,
        },
      ],
      timestamp: T + 7_000,
    },
  ];
}

function seedStandaloneWorkflowChat(userDataDir) {
  const rootDir = path.join(userDataDir, 'standalone-chat');
  const projectDir = path.join(rootDir, 'default');
  const createdAt = '2026-04-10T12:00:00.000Z';

  writeJson(path.join(rootDir, 'projects.json'), {
    version: 1,
    projects: [
      {
        id: 'default',
        name: 'Default',
        createdAt,
        color: '#7C9B6D',
        defaultModel: 'gpt-6-luna',
      },
    ],
  });

  writeJson(path.join(projectDir, 'project.json'), {
    version: 1,
    id: 'default',
    name: 'Default',
    createdAt,
    color: '#7C9B6D',
    description: 'Workflow block rendering fixture',
    defaultModel: 'gpt-6-luna',
  });

  writeText(
    path.join(projectDir, 'CLAUDE.md'),
    'Workflow block rendering fixture instructions.\n',
  );

  writeJson(path.join(projectDir, 'chat-tabs.json'), {
    version: 1,
    activeTabId: 'chat-workflow',
    tabs: [
      {
        id: 'chat-workflow',
        title: 'Workflow Chat',
        description: 'Workflow block render coverage',
        createdAt,
        providerType: 'claude',
        planMode: false,
        proposalMode: 'optional',
        thinkingLevel: 'high',
        messages: buildMessages(),
      },
    ],
  });
}

async function launchSeededWorkflowCanopy() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-workflow-block-'),
  );
  seedStandaloneWorkflowChat(userDataDir);

  try {
    const launched = await launchCanopy({ userDataDir });
    return { ...launched, seededUserDataDir: userDataDir };
  } catch (error) {
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  }
}

test('renders the workflow card with a receipt folded from a later message', async ({}, testInfo) => {
  const { electronApp, seededUserDataDir } = await launchSeededWorkflowCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell();

    // Individual-step assertions use the Detailed preference.

    await window.evaluate(() =>
      window.api.savePreferences({ chatDetail: 'detailed' }),
    );
    await app.openChatPage();

    // Exactly one workflow card, with the receipt fields merged in: the name
    // parsed from the script's meta block and the receipt's summary line.
    const card = window.locator('[data-testid="workflow-block"]');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Workflow');
    await expect(card).toContainText('nightly-review');
    await expect(card).toContainText('3 phases queued');
    // `data-launched="true"` requires the runId parsed out of the folded
    // receipt — a stale card (receipt not merged) reports "false" and shows
    // "Launching workflow…" when expanded.
    await expect(card).toHaveAttribute('data-launched', 'true');

    // The tool_result-only carrier message must be folded away entirely; the
    // parsed receipt fields update the card, but the raw receipt text is not
    // rendered as a standalone message body or inside the card.
    const receiptOccurrences = window.getByText(
      'Workflow launched in background.',
      { exact: false },
    );
    await expect(receiptOccurrences).toHaveCount(0);

    await window.screenshot({
      path: testInfo.outputPath('workflow-block-render.png'),
    });
  } finally {
    await closeCanopy(electronApp, seededUserDataDir);
  }
});
