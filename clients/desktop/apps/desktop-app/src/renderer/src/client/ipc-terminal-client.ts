import type { TerminalClient } from '@canopy/app-core';
import { ipcCanopyClient } from './ipc-canopy-client';

/**
 * The terminal slice of the desktop CanopyClient. The portable adapter
 * (`@canopy/ipc-canopy-client`) maps `terminal.*` onto the terminal channels
 * and keeps the renderer's output-delivery diagnostics through its
 * `observeTerminalOutput` port.
 */
export const ipcTerminalClient: TerminalClient = ipcCanopyClient;
