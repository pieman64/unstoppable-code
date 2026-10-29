import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import { seedWorktreeChat } from './seedWorktreeChat.mjs';

export const MERMAID_SOURCE =
  'flowchart LR\n  A[Write Markdown] --> B[Preview diagram]\n  B --> C[Share the plan]';
export const MERMAID_PLACEHOLDER_SOURCE = [
  'sequenceDiagram',
  '  participant A as Agent',
  '  participant T as Tool runtime (main)',
  '  participant S as Visual staging',
  '  participant C as Chat storage V2',
  '  participant R as Renderer / Portal',
  '  A->>T: ShowVisual { html, title, height }',
  '  T->>T: validate, inline authorized images',
  '  T->>S: stage prepared document and sidecar (visualId, scope, chat)',
  '  T-->>A: "vis_<uuid>" token + "shown above your reply"',
  '  Note over C: provider event commits the tool result (possibly much later)',
  '  C->>S: read staged document for this scope and chat (non-destructive)',
  '  C->>C: publish chat-scoped artifact, set visualRef, record owner',
  '  C->>S: delete staging entry after the commit is durable',
  '  R->>C: core.chat.visual.read (paged)',
  '  R->>R: wrapper frame (agent CSP) + inner sandboxed srcdoc with theme and bridge',
].join('\n');
export const MERMAID_MARKDOWN = [
  '# Diagram preview',
  '',
  'A diagram alongside ordinary Markdown.',
  '',
  '```mermaid',
  MERMAID_SOURCE,
  '```',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  Alice->>Bob: Review the plan',
  '  Bob-->>Alice: Approved',
  '```',
  '',
  '```mermaid',
  'this is not a diagram',
  '```',
  '',
  '```text',
  'flowchart LR; keep this as code',
  '```',
].join('\n');

export function seedMarkdownMermaid({
  file = false,
  markdown = MERMAID_MARKDOWN,
} = {}) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-mermaid-'));
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const filePath = path.join(seed.workspaces[0].worktreePath, 'DIAGRAM.md');
  writeFileSync(filePath, markdown);
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    activeTabId: 'mermaid-preview',
    tabs: [
      {
        id: 'mermaid-preview',
        title: 'Diagram preview',
        ...(file
          ? { kind: 'file', filePath, fileViewMode: 'preview', messages: [] }
          : { blocks: [{ type: 'text', text: markdown }] }),
      },
    ],
  });
  return userDataDir;
}
