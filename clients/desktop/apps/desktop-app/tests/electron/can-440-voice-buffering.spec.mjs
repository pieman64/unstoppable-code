// Durable CAN-440 flow: real chat/home composers and actual outgoing IPC payload.
// No live microphone, Swift helper or agent is needed; see CAN-3794's audio seam.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { openPipelineAssistant } from './pipelineAssistant.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  editWhileRecording,
  emitVoice,
  installScriptedVoice,
  readVoiceSends,
  selectVoiceDraft,
} from './voiceBufferingFixture.mjs';

for (const surface of ['chat', 'home']) {
  for (const terminal of ['final', 'stopped', 'error']) {
    test(`${surface}: ${terminal} preserves edits and sends only a completed take`, async () => {
      test.setTimeout(120_000);
      const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can440-voice-'));
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedWorktreeChat({
        userDataDir,
        workspaceId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
        activeTabId: 'can440-chat',
        providerType: 'claude',
        tabs: [{ id: 'can440-chat', title: 'Dictation', messages: [] }],
      });
      const { electronApp } = await launchCanopy({
        userDataDir,
        env: { CANOPY_E2E_VOICE_ACCESS_FLOW: 'grant-after-request' },
      });
      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell();
        await installScriptedVoice(electronApp, window);
        await app.openMainPage();
        await app.selectWorktree('demo-main');
        if (surface === 'home')
          await window.getByTestId('sidebar-create-task').click();
        const composer =
          surface === 'home'
            ? window.getByTestId('page-home')
            : window.getByTestId('panel-content-chat');
        const editor =
          surface === 'home'
            ? composer.getByTestId('home-composer-editor')
            : composer.getByRole('textbox');
        await editor.fill('Draft note');
        await composer.getByTestId('voice-input-button').click();
        await expect(composer.getByTestId('voice-recording-row')).toBeVisible();
        await emitVoice(electronApp, window, {
          type: 'interim',
          text: 'first snapshot',
        });
        await expect(editor).toHaveText('Draft note');
        await editWhileRecording(editor);
        await emitVoice(electronApp, window, {
          type: 'interim',
          text: 'heard words',
        });
        await expect(editor).toHaveText('raft note!');
        await composer.getByTestId('voice-recording-send').click();
        expect(await readVoiceSends(electronApp)).toEqual([]);
        await emitVoice(
          electronApp,
          window,
          terminal === 'final'
            ? { type: 'final', text: 'Final words.' }
            : terminal === 'error'
              ? { type: 'error', message: 'Speech recognition failed' }
              : { type: 'stopped' },
        );
        if (terminal === 'error') {
          await expect(editor).toHaveText('raft note! heard words');
          expect(await readVoiceSends(electronApp)).toEqual([]);
          // Close guidance, then finish an unrelated take without pressing Send.
          await window.getByTestId('voice-error-modal-close').click();
          await composer.getByTestId('voice-input-button').click();
          await expect(
            composer.getByTestId('voice-recording-row'),
          ).toBeVisible();
          await emitVoice(electronApp, window, {
            type: 'final',
            text: 'later take',
          });
          await emitVoice(electronApp, window, { type: 'stopped' });
          await expect(editor).toHaveText('raft note! heard words later take');
          expect(await readVoiceSends(electronApp)).toEqual([]);
        } else {
          await expect
            .poll(() => readVoiceSends(electronApp))
            .toEqual([
              {
                text: `raft note! ${terminal === 'final' ? 'Final words.' : 'heard words'}`,
              },
            ]);
          await emitVoice(electronApp, window, { type: 'stopped' });
          expect(await readVoiceSends(electronApp)).toHaveLength(1);
        }
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }
}

for (const armedSend of [false, true]) {
  test(`changing chat destination discards an old take with send ${armedSend ? 'armed' : 'unarmed'}`, async () => {
    test.setTimeout(120_000);
    const { electronApp, userDataDir } = await launchCanopy({
      env: { CANOPY_E2E_VOICE_ACCESS_FLOW: 'grant-after-request' },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await installScriptedVoice(electronApp, window);
      const panel = await openPipelineAssistant(app);
      const editor = panel.getByRole('textbox');
      await editor.fill('Old draft');
      await selectVoiceDraft(editor);
      await panel.getByTestId('voice-input-button').click();
      await expect(panel.getByTestId('voice-recording-row')).toBeVisible();
      await emitVoice(electronApp, window, {
        type: 'interim',
        text: 'old take words',
      });
      if (armedSend) await panel.getByTestId('voice-recording-send').click();
      await panel.getByTestId('chat-tab-new').click();
      await editor.fill('New draft');
      await selectVoiceDraft(editor);
      await emitVoice(electronApp, window, {
        type: 'final',
        text: 'old take words',
      });
      await emitVoice(electronApp, window, { type: 'stopped' });
      await expect(editor).toHaveText('New draft');
      expect(await readVoiceSends(electronApp)).toEqual([]);
      await expect(panel.getByTestId('voice-recording-row')).toHaveCount(0);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
