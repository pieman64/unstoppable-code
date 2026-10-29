export function workspaceHealthIssueClassName(blocking: boolean): string {
  return blocking
    ? 'border-line-destructive/30 bg-destructive-subtle fg-destructive'
    : 'border-line-attention/30 bg-warning-subtle fg-warning';
}
