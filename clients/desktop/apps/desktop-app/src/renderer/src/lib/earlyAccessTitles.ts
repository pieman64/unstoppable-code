// Sentence-case display titles preserve compatibility with stored layouts.

const SENTENCE_CASE_TITLES: ReadonlyMap<string, string> = new Map([
  ['Change Diagram', 'Change diagram'],
  ['File Explorer', 'File explorer'],
  ['Changed Files', 'Changed files'],
  ['Pull Request', 'Pull request'],
  ['Pull Requests', 'Pull requests'],
  ['Agent Background Processes', 'Agent background processes'],
  ['MCP Servers', 'MCP servers'],
  ['Agent Tasks', 'Agent tasks'],
  ['Pipeline Runs', 'Workflow runs'],
  ['Dispatch Pipeline', 'Dispatch workflow'],
  // Default titles layouts stored before the CAN-4651 rename.
  ['Pipeline runs', 'Workflow runs'],
  ['Pipeline run', 'Workflow run'],
  ['Browse MCP Servers', 'Browse MCP servers'],
]);

/** Map persisted titles at display time without changing user-owned names. */
export function earlyAccessTitle(title: string): string {
  return SENTENCE_CASE_TITLES.get(title) ?? title;
}
export function currentEarlyAccessTitle(title: string): string {
  return earlyAccessTitle(title);
}
export function useEarlyAccessTitle(title: string): string {
  return earlyAccessTitle(title);
}
