import type { AgentActionCatalogEntry } from '../../catalog/types';
import type { EditorSetupAction } from './actions';

export const editorSetupActionCatalog: readonly AgentActionCatalogEntry<
  EditorSetupAction['type'],
  EditorSetupAction
>[] = [
  {
    type: 'navigation.open_editor_setup',
    category: 'navigation',
    summary:
      "Open the Cursor rules review, where the member can choose a code project's Cursor rules to use in new chats.",
    fields: [
      {
        name: 'workspaceId',
        type: 'string',
        required: false,
        description:
          'Code project to review. Omit it to let the member choose the project.',
      },
    ],
    example: {
      type: 'navigation.open_editor_setup',
      workspaceId: 'workspace-id',
    },
    keywords: [
      'cursor rules',
      'cursorrules',
      '.cursor/rules',
      'editor setup',
      'project rules',
      'repo rules',
      'repository rules',
      'import cursor',
      'migrate from cursor',
    ],
    notes: [
      'Opens the review only. The member consents to the scan and chooses which rules to use; Orchestrator cannot scan, preview, or apply rules.',
      'Cowork projects do not use Cursor rules; pass a code project id or omit workspaceId.',
    ],
  },
];
