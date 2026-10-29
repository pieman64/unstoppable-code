// CAN-440: retain the real preload, provider, hook, Slate editor and composer.
// Replace OS capture and existing native voice handlers as CAN-3794 does.
import { expect } from '@playwright/test';

export async function installScriptedVoice(electronApp, window) {
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__can440Sends = [];
    for (const name of [
      'is-supported',
      'request-system-access',
      'start',
      'stop',
      'cancel',
    ]) {
      ipcMain.removeHandler(`voice:${name}`);
    }
    ipcMain.handle('voice:is-supported', () => ({ supported: true }));
    ipcMain.handle('voice:request-system-access', () => ({
      microphone: 'granted',
      speechRecognition: 'granted',
    }));
    ipcMain.handle('voice:start', (_event, request) => {
      globalThis.__can440SessionId = request.sessionId;
      return { sessionId: request.sessionId };
    });
    ipcMain.handle('voice:stop', () => ({}));
    ipcMain.handle('voice:cancel', () => ({}));
    ipcMain.removeHandler('chat:send-message');
    ipcMain.handle('chat:send-message', (_event, request) => {
      globalThis.__can440Sends.push(request);
      return {};
    });
  });
  await window.evaluate(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
      },
    });
    window.AudioContext = class {
      audioWorklet = { addModule: async () => {} };
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      async close() {}
    };
    window.AudioWorkletNode = class {
      port = { onmessage: null };
      disconnect() {}
    };
  });
}

export async function emitVoice(electronApp, window, event) {
  await electronApp.evaluate(({ BrowserWindow }, data) => {
    BrowserWindow.getAllWindows()[0].webContents.send('voice:event', {
      sessionId: globalThis.__can440SessionId,
      ...data,
    });
  }, event);
  // Flush the IPC event before asserting unchanged text or absent sends.
  await window.evaluate(() => window.api.voice.isSupported());
}

export function readVoiceSends(electronApp) {
  return electronApp.evaluate(() =>
    globalThis.__can440Sends.map(({ text }) => ({ text })),
  );
}

export async function selectVoiceDraft(editor, deleteOriginal = false) {
  await expect(async () => {
    await editor.evaluate((element, removeFirst) => {
      const text = element.querySelector('[data-slate-string]')?.firstChild;
      if (!(text instanceof Text)) throw new Error('Missing draft text node');
      document
        .getSelection()
        .setBaseAndExtent(
          text,
          removeFirst ? 0 : text.length,
          text,
          removeFirst ? 1 : text.length,
        );
    }, deleteOriginal);
    await editor.page().waitForTimeout(200);
    const selection = await editor.evaluate((element) => {
      const text = element.querySelector('[data-slate-string]')?.firstChild;
      const current = document.getSelection();
      return {
        text: current?.toString(),
        atEnd:
          current?.anchorNode === text &&
          current?.anchorOffset === text?.textContent?.length &&
          current?.isCollapsed,
      };
    });
    if (deleteOriginal) expect(selection.text).toBe('D');
    else expect(selection.atEnd).toBe(true);
  }).toPass({ timeout: 5000 });
}

export async function editWhileRecording(editor) {
  // Position a real DOM selection, then send real keyboard input. Slate's
  // selectionchange handler is throttled, so allow it to observe each move.
  await editor.click();
  await selectVoiceDraft(editor);
  await editor.pressSequentially('!');
  await expect(editor).toHaveText('Draft note!');
  await selectVoiceDraft(editor, true);
  await expect
    .poll(() => editor.evaluate(() => document.getSelection()?.toString()))
    .toBe('D');
  await editor.press('Backspace');
  await expect(editor).toHaveText('raft note!');
  await selectVoiceDraft(editor);
}
