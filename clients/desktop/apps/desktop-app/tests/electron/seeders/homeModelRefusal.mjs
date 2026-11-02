// Deterministic CAN-5021 seam: only model application is refused; all creation,
// hydration and settings still run through production handlers.
export async function installHomeModelRefusal(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    const channels = [
      'chat:model-change',
      'chat:send-message',
      'worktree:create',
    ];
    globalThis.__can5021 = {
      originals: new Map(
        channels.map((name) => [name, ipcMain._invokeHandlers.get(name)]),
      ),
      applications: [],
      sends: [],
      creations: 0,
      refuse: true,
      hold: false,
    };
    const state = globalThis.__can5021;
    for (const name of channels) {
      if (typeof state.originals.get(name) !== 'function')
        throw new Error(`Missing ${name}`);
      ipcMain.removeHandler(name);
    }
    ipcMain.handle('chat:model-change', async (event, request) => {
      state.applications.push(request);
      if (state.hold)
        await new Promise((resolve) => {
          state.release = resolve;
        });
      if (state.refuse) return false;
      return state.originals.get('chat:model-change')(event, request);
    });
    ipcMain.handle('chat:send-message', (_event, request) => {
      state.sends.push(request);
      return {};
    });
    ipcMain.handle('worktree:create', async (event, request) => {
      state.creations += 1;
      return {
        ...(await state.originals.get('worktree:create')(event, request)),
        setupPhase: 'git-ready',
      };
    });
  });
}

export async function restoreHomeModelRefusal(electronApp) {
  await electronApp.evaluate(({ ipcMain }) => {
    const state = globalThis.__can5021;
    state?.release?.();
    for (const [name, handler] of state?.originals ?? []) {
      ipcMain.removeHandler(name);
      ipcMain.handle(name, handler);
    }
    delete globalThis.__can5021;
  });
}

export async function startHomeFailureSampler(window, prompt) {
  await window.evaluate((prompt) => {
    globalThis.__can5021Frames = [];
    globalThis.__can5021Sampling = true;
    const sample = () => {
      if (!globalThis.__can5021Sampling) return;
      const panel = document.querySelector(
        '[data-testid="panel-content-chat"]',
      );
      if (panel && panel.getBoundingClientRect().width > 0) {
        globalThis.__can5021Frames.push({
          prompt: panel.textContent?.includes(prompt) === true,
          title: Array.from(
            document.querySelectorAll('[role="tab"][data-panel-kind="chat"]'),
          ).some((tab) => tab.textContent?.includes(prompt.slice(0, 40))),
          empty:
            panel.textContent?.includes('Send a message to start working') ===
            true,
          onboarding: !!panel.querySelector(
            '[data-testid="chat-onboarding-checklist-host"], [data-testid="suggested-prompt-chips"]',
          ),
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, prompt);
}

export async function stopHomeFailureSampler(window) {
  return window.evaluate(() => {
    globalThis.__can5021Sampling = false;
    return globalThis.__can5021Frames;
  });
}

// Choose Luna before changing routes. A nonempty loaded catalog still knows
// Luna as a native model, but only another model can use the credits route.
export async function excludeHomeModelCreditsRoute(window, electronApp) {
  const snapshot = await window.evaluate(() => window.api.getModelRegistry());
  const routes = snapshot.gatewayRoutes.filter(
    (route) => route.modelId !== 'gpt-5.6-luna',
  );
  if (routes.length === 0 || routes.length === snapshot.gatewayRoutes.length) {
    throw new Error(
      'Expected Luna plus another gateway route in the coherent refusal fixture',
    );
  }
  await electronApp.evaluate(
    ({ ipcMain, BrowserWindow }, snapshot) => {
      const state = globalThis.__can5021;
      const name = 'model-registry:get';
      state.originals.set(name, ipcMain._invokeHandlers.get(name));
      ipcMain.removeHandler(name);
      ipcMain.handle(name, () => snapshot);
      for (const win of BrowserWindow.getAllWindows())
        win.webContents.send('model-registry:updated', snapshot);
    },
    { ...snapshot, gatewayRoutes: routes },
  );
}
