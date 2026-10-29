import type { ShellType } from '@canopy/desktop-shared/types/pipeline';

/**
 * Display-ready label for each supported pipeline shell.
 *
 * Surfaced in the pipeline editor's "Run defaults" shell dropdown and the per-
 * step shell dropdown so users can explicitly select any shell the executor
 * supports — including Windows-only shells (`pwsh`, `powershell`, `cmd`).
 *
 * The "Default" entry is intentionally omitted: it is platform-aware and lives
 * in `uiText.pipelineShell.unsetDefault` so callers can prepend it at render
 * time via `pt(uiText.pipelineShell.unsetDefault)`.
 */
export interface PipelineShellOption {
  value: ShellType | '';
  label: string;
}

export const PIPELINE_SHELL_OPTIONS: ReadonlyArray<{
  value: ShellType;
  label: string;
}> = [
  { value: 'bash', label: 'Bash' },
  { value: 'sh', label: 'sh' },
  { value: 'pwsh', label: 'PowerShell 7' },
  { value: 'powershell', label: 'Windows PowerShell' },
  { value: 'cmd', label: 'Command Prompt' },
  { value: 'python', label: 'Python' },
  { value: 'node', label: 'Node.js' },
  { value: 'tsx', label: 'TSX' },
];
