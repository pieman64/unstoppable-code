// Typed boundary over the untyped `.mjs` Electron harness modules, mirroring
// the local-memory-bench-runtime.d.mts pattern. Only the surface the benchmark
// uses is declared; keep these signatures in sync with the harness sources.
import type { ElectronApplication, Page } from 'playwright-core';

export declare class CanopyAppDriver {
  constructor(page: Page);
  waitForShell(options: { timeout: number }): Promise<void>;
  openMainPage(): Promise<void>;
  selectWorktree(worktreeId: string): Promise<void>;
}

export declare function seedDemoWorkspaces(options: {
  userDataDir: string;
  apps: string[];
}): void;

export declare function seedWorktreeChat(options: {
  userDataDir: string;
  workspaceId: string;
  worktreeId: string;
  providerType: 'claude' | 'codex';
  activeTabId: string;
  tabs: Array<{
    id: string;
    title: string;
    providerType: 'claude' | 'codex';
    model: string;
  }>;
}): void;

export declare function launchCanopy(options: {
  userDataDir: string;
  preserveProviderState: boolean;
  env: Record<string, string>;
}): Promise<{ electronApp: ElectronApplication }>;

export declare function closeCanopy(
  electronApp: ElectronApplication,
  userDataDir: string,
  options?: { keepUserData?: boolean },
): Promise<void>;
