// @capture-keep: reference demo video for the `*.demo-spec.ts` authoring pattern
// @capture-reference: docs/ui-automation.md
/**
 * Reference demo: asking the agent a question in a project chat, then a short
 * tour of the model picker, search, Automations, Pipelines, the marketplace,
 * and the projects overview before returning to the chat.
 *
 * This is the worked example for `*.demo-spec.ts` demo videos (see "Demo
 * videos" in docs/ui-automation.md). It records a human-paced walkthrough with
 * a visible cursor, typed input, and captions, headlessly, into
 * `.playwright/demo-chat-turn/`:
 *
 *   chat-turn-light.webm            the video (VP8 WebM, device-pixel size)
 *   chat-turn-light.timeline.json   steps, clicks, keys, and captions by time
 *   chat-turn-light-steps/*.jpg     a still per `demo.step()`, for review
 *                                   without playing the video
 *
 * Run from the repo root (the second line records dark mode):
 *
 *   pnpm run test:electron:demos:built demo-chat-turn.demo-spec.ts --reporter=line
 *   pnpm run test:electron:demos:built demo-chat-turn.demo-spec.ts --reporter=line --dark-mode
 *
 * Use `pnpm run test:electron:demos ...` when the E2E bundle needs building.
 * `CANOPY_DEMO_PACE=0` replays the same script at test speed while iterating;
 * add `CANOPY_DEMO_RECORD=0` to skip recording too.
 *
 * Determinism: the project, its worktree, and the earlier conversation are
 * seeded into a test-scoped data dir before launch, and the mock provider
 * streams the only reply. The scenario is keyed by the typed prompt
 * (`registerDemoReply`), so the reply and the helper requests it triggers
 * (branch name, chat title) are scripted without a visible mock marker.
 * Branch-prefix preferences are seeded so the host's identity never appears.
 * Cursor paths and typing rhythm come from a fixed seed. No live agents, no
 * network.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { startDemo } from './demo/demoDirector.mjs';
import {
  DEMO_VIEWPORT,
  registerDemoReply,
  seedDemoPreferences,
} from './demo/demoLaunch.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedAutomations, seedWorktreeChat } from './seeders/index.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const demoDir = path.join(repoRoot, '.playwright', 'demo-chat-turn');

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'demo-chat-turn';
const PROMPT = 'Where should I add a dark mode toggle in this app?';
const STARTED_AT = Date.parse('2026-09-30T15:00:00.000Z');

const REPLY = [
  'The toggle fits best in the app header, next to the existing counter',
  'controls. Three small changes cover it:',
  '',
  '1. **`src/theme.ts`**: add a `useTheme()` hook that reads the saved',
  '   preference, falls back to `prefers-color-scheme`, and writes the',
  '   choice to `localStorage`.',
  '2. **`src/App.tsx`**: render a `ThemeToggle` button in the header and',
  '   set `data-theme` on `<html>` whenever the theme changes.',
  '3. **`src/index.css`**: move the colors into CSS variables and add a',
  '   `[data-theme="dark"]` block that overrides them.',
  '',
  'Want me to make these changes on a new branch?',
].join('\n');

function seedConversation(userDataDir: string): void {
  const message = (
    id: string,
    role: 'user' | 'assistant',
    text: string,
    minutes: number,
  ) => ({
    id,
    role,
    blocks: [{ type: 'text' as const, text }],
    timestamp: STARTED_AT + minutes * 60_000,
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Theme support',
        messages: [
          message(
            'history-user-1',
            'user',
            'Give me a quick tour of how this app is structured.',
            0,
          ),
          message(
            'history-assistant-1',
            'assistant',
            'It is a Vite + React app. `src/main.tsx` mounts `App`, which owns ' +
              'the page layout, and `src/index.css` holds the global styles. ' +
              'There is no routing or state library yet, so new UI state can ' +
              'live in small hooks next to the components that use it.',
            1,
          ),
        ],
      },
    ],
  });
}

function seedDemoAutomations(userDataDir: string): void {
  const timestamps = {
    createdAt: '2026-09-28T16:00:00.000Z',
    updatedAt: '2026-09-28T16:00:00.000Z',
    failureCount: 0,
  };
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: 'demo-nightly-review',
        name: 'Nightly code review',
        enabled: true,
        schedule: {
          kind: 'cron',
          expression: '0 2 * * 1-5',
          timezone: 'local',
        },
        action: {
          type: 'worktree_pipeline',
          workspaceId: WORKSPACE_ID,
          pipelineId: 'bundled-code-review-claude',
          pipelineSource: 'bundled',
          pipelineName: 'Code Review (Claude)',
          inputs: {},
        },
        ...timestamps,
      },
      {
        version: 1,
        id: 'demo-weekly-review',
        name: 'Weekly Codex review',
        enabled: true,
        schedule: { kind: 'cron', expression: '0 9 * * 1', timezone: 'local' },
        action: {
          type: 'worktree_pipeline',
          workspaceId: WORKSPACE_ID,
          pipelineId: 'bundled-code-review-codex',
          pipelineSource: 'bundled',
          pipelineName: 'Code Review (Codex)',
          inputs: {},
        },
        ...timestamps,
      },
    ],
  });
}

test('demo: ask the agent a question, then tour the app', async () => {
  test.setTimeout(300_000);
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-demo-chat-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedConversation(userDataDir);
  seedDemoAutomations(userDataDir);
  seedDemoPreferences(userDataDir);
  await registerDemoReply(PROMPT, {
    steps: [{ text: REPLY, stopReason: 'end_turn', streamMs: 4_000 }],
    helperStepsById: {
      'branch-naming': {
        text: JSON.stringify({ branchName: 'dark-mode-toggle' }),
        stopReason: 'end_turn',
      },
      'topic-summary': { text: 'Dark mode toggle', stopReason: 'end_turn' },
    },
  });

  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: DEMO_VIEWPORT,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.getByTestId('panel-content-chat');
    const composer = window.getByRole('textbox').last();
    await composer.waitFor({ state: 'visible' });

    // Recording starts only once the app is ready, so the video opens on the
    // project rather than on startup.
    const demo = await startDemo(window, {
      dir: demoDir,
      name: 'chat-turn',
      seed: 7,
      record: process.env.CANOPY_DEMO_RECORD !== '0',
    });
    try {
      await demo.beat('short');
      await demo.caption('Pick up a project conversation where you left off');
      await demo.step('Project chat');

      await demo.caption('Ask the agent a question about the code', {
        hold: 'short',
      });
      await demo.type(composer, PROMPT);
      await demo.step('Prompt typed');
      await demo.press('Enter', { after: 'tiny' });

      await demo.caption('The answer streams in as the agent works');
      await demo.waitFor(
        panel.getByText('Want me to make these changes on a new branch?'),
        { hold: 'result' },
      );
      await demo.step('Reply complete');

      await demo.caption('Review the plan before you continue');
      await demo.hover(panel.getByText('src/theme.ts').first(), {
        dwell: 'read',
      });

      // A short tour of the rest of the app.
      await demo.caption('Switch models for the next turn');
      const modelPicker = window
        .locator('[data-testid="chat-model-picker"]:visible')
        .first();
      await demo.click(modelPicker);
      await demo.waitFor(window.getByTestId('chat-model-menu'), {
        hold: 'read',
      });
      await demo.step('Model picker');
      await demo.press('Escape');

      await demo.caption('Search chats, projects, and commands');
      await demo.click(window.getByTestId('sidebar-search'));
      const palette = window.getByTestId('command-palette');
      await demo.waitFor(palette, { hold: 'short' });
      await demo.type(window.getByTestId('command-palette-input'), 'theme');
      await demo.beat('read');
      await demo.step('Search palette');
      await demo.press('Escape');

      await demo.caption('Schedule recurring work with automations');
      await demo.click(window.getByTestId('sidebar-nav-workflows'));
      await demo.waitFor(window.getByTestId('page-workflows-runs'), {
        hold: 'tiny',
      });
      // Drift off the sidebar so its tooltip does not cover the page.
      await demo.hover(window.getByTestId('workflows-tab-workflows'), {
        dwell: 'result',
      });
      await demo.step('Automations');

      await demo.caption('Run multi-step pipelines');
      await demo.click(window.getByTestId('workflows-tab-workflows-library'));
      await demo.waitFor(window.getByTestId('page-workflows-library'), {
        hold: 'tiny',
      });
      await demo.hover(window.getByTestId('workflows-tab-workflows-library'), {
        dwell: 'result',
      });
      await demo.step('Pipelines');

      await demo.caption('Add skills and plugins from the marketplace');
      await demo.click(window.getByTestId('sidebar-nav-plugins'));
      await demo.waitFor(window.getByTestId('page-plugins'), { hold: 'tiny' });
      // Drift off the sidebar so its tooltip does not cover the page.
      await demo.hover(
        window
          .getByTestId('page-plugins')
          .getByText('Customize', { exact: true })
          .first(),
        { dwell: 'result' },
      );
      await demo.step('Customize');

      await demo.caption('See every project at a glance');
      await demo.click(window.getByTestId('sidebar-nav-overview'));
      await demo.waitFor(window.getByTestId('overview-page'), { hold: 'tiny' });
      // Drift off the sidebar so its tooltip does not cover the page.
      await demo.hover(
        window
          .getByTestId('overview-page')
          .getByText('Overview', { exact: true })
          .first(),
        { dwell: 'result' },
      );
      await demo.step('Overview');

      await demo.caption('Then jump back into the conversation');
      await demo.click(
        window
          .locator(
            `[data-testid="worktree-row"][data-worktree-id="${WORKTREE_ID}"]`,
          )
          .first(),
      );
      await demo.waitFor(composer, { hold: 'short' });
      await demo.click(composer, { after: 'result' });
      await demo.step('Back in the chat');
    } finally {
      const result = await demo.finish();
      if (result) {
        console.log(
          `[demo] ${path.relative(repoRoot, result.videoPath)} ` +
            `(${(result.durationMs / 1000).toFixed(1)}s, ${result.frameCount} frames)`,
        );
      }
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
