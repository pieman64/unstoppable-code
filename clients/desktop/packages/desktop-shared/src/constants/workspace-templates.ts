export function getDefaultWorkspaceClaudeMd(workspaceName: string): string {
  return `# ${workspaceName} - Multi-Repository Project

This project contains multiple individual git repositories. Each repository may provide AGENTS.md or legacy CLAUDE.md files with specific guidance; read the applicable instructions from both when present. The individual repos exist within the repos/ subdirectory.

**Working across repos:** Start by identifying the relevant repo(s) with lightweight, read-only discovery at the project level — for example, reading the task, checking file paths and imports, reviewing ticket context, and consulting repo AGENTS.md and legacy CLAUDE.md files when present. If you're still unsure after that and there are multiple plausible repos, ask the user to confirm. Do not do deeper project exploration or run repo-specific commands yourself at the top level.

**Important:** For any non-trivial task, deeper exploration, file changes, or command execution, always use Agent Teams or Sub Agents isolated to individual repos. Always instruct sub agents to work within the designated repo only and to review its AGENTS.md and legacy CLAUDE.md files when present before beginning work. Agents should set their working directory to the individual repo directory and execute git commands within that context.

**Important:** Handling git branches:
- Git branches/repos only exist in the individual nested repos, not top level. When the user is asking for a git related change or command, they mean within the individual nested repos.
- When renaming git branches, always ensure branch names stay in sync across all repos within the project. If any branches have been pushed to a remote, warn the user and allow them to confirm the rename for each repo before proceeding.
`;
}
