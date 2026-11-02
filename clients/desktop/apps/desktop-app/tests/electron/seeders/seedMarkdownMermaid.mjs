import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
// CAN-5039: the exact journey brief diagram; unit and web flows use the same text.
export const JOURNEY_BRIEF_DIAGRAM = [
  'flowchart LR',
  '  Cart --> Promo["Promo code?"]',
  '  Promo --> Shipping["Shipping address"]',
  '  Shipping --> Payment',
  '  Payment --> Billing["Billing address (again)"]',
  '  Billing --> Review',
  '  Review --> Confirm',
  '  classDef pain fill:#fde2e2,stroke:#d9534f,color:#5a1a1a',
  '  class Promo,Billing,Review pain',
].join('\n');
// Quoted and unquoted labels keep directive-like lines as authored text.
export const MULTILINE_LABEL_DIAGRAM = [
  'flowchart LR',
  'A["First line',
  'style A font-size:20px',
  'Last line"]-->B',
  'B[Unquoted node',
  'style B font-size:25px',
  'Last node line]-->C',
  'C-->|Unquoted edge',
  'style C font-size:30px',
  'Last edge line|D',
  'D>Asymmetric node',
  'style D font-size:35px',
  'Last asymmetric line]-->E',
  'E--Bare edge',
  'style guide',
  'before checkout-->F',
  'style B fill:#fde2e2',
].join('\n');
export const PARTIALLY_STYLED_DIAGRAM = [
  'flowchart LR',
  '  A[Upload] --> B[Reader]',
  '  B --> C[(import_rows)]',
  '  D[100%% done]',
  '  style A fill:#ff99ff,stroke:#333333,font-size:20px',
  '  linkStyle 1 stroke:#d9534f,stroke-width:3px',
  '  style D fill:#fde2e2,opacity:0',
].join('\n');
export const REMOVED_STYLING_DIAGRAM = [
  'flowchart LR',
  '  A[Draft] --> B[Publish]',
  '  classDef big font-size:40px',
  '  class A big',
].join('\n');
export const HOSTILE_STYLED_SOURCES = [
  ...['[', '(', '{', '|', '>'].map(
    (delimiter) =>
      `flowchart LR\ndirection LR ${delimiter}\nA-->B\nstyle A fill:red,opacity:0`,
  ),
  'flowchart LR\nA-->B\nclassDef x fill:#f00,mask-image:image-set("https://mermaid-tracker.invalid/a")\nclass A x',
  String.raw`flowchart LR
A-->B
style A fill:#f00,stroke:u\72l(https://mermaid-tracker.invalid/b)`,
  'flowchart LR\nA-->B\nstyle A fill:#f00\nclick A "https://mermaid-tracker.invalid/c"',
  'flowchart LR\nA-->B\nstyle A fill:#f00; background:url(https://mermaid-tracker.invalid/d)',
];
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

/** Seeds DIAGRAM.md; the absolute path is the seeded worktree's Markdown document. */
export function mermaidDocumentPath(userDataDir) {
  return readFileSync(path.join(userDataDir, MERMAID_DOCUMENT_POINTER), 'utf8');
}

const MERMAID_DOCUMENT_POINTER = 'mermaid-document-path.txt';

export function seedMarkdownMermaid({
  file = false,
  markdown = MERMAID_MARKDOWN,
} = {}) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-mermaid-'));
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const filePath = path.join(seed.workspaces[0].worktreePath, 'DIAGRAM.md');
  writeFileSync(filePath, markdown);
  writeFileSync(path.join(userDataDir, MERMAID_DOCUMENT_POINTER), filePath);
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
