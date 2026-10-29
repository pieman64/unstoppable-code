import { writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Seeds the default-like Advanced topology used by layout-mode regressions:
 * Chat over an unbound Terminal placeholder, with Activity on the right.
 */
export function seedAdvancedDefaultPanelLayout({ userDataDir }) {
  writeFileSync(
    path.join(userDataDir, 'default-panel-layout.json'),
    JSON.stringify({
      version: 1,
      layout: {
        version: 1,
        grid: {
          root: {
            type: 'branch',
            children: [
              {
                type: 'branch',
                children: [
                  {
                    type: 'leaf',
                    groupId: 'group-chat',
                    panels: [],
                    activePanelId: null,
                    size: 600,
                  },
                  {
                    type: 'leaf',
                    groupId: 'group-terminal',
                    panels: [{ panelId: 'panel-terminal', kind: 'terminal' }],
                    activePanelId: 'panel-terminal',
                    size: 257,
                  },
                ],
                size: 1143,
              },
              {
                type: 'leaf',
                groupId: 'group-activity',
                panels: [
                  { panelId: 'panel-activity', kind: 'activity-section' },
                  { panelId: 'panel-files', kind: 'file-explorer' },
                ],
                activePanelId: 'panel-activity',
                size: 443,
              },
            ],
            size: 857,
          },
          orientation: 1,
          width: 1586,
          height: 857,
        },
        activeGroupId: 'group-chat',
        mostRecentActiveGroupIds: [
          'group-chat',
          'group-activity',
          'group-terminal',
        ],
      },
    }),
    'utf8',
  );
}
