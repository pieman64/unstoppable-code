/** Stable panel id for a terminal session bound into the workspace grid. */
export function terminalPanelIdFor(terminalId: string): string {
  return `panel-terminal-${terminalId}`;
}
