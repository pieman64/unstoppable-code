/**
 * Stable group/panel ids for the default worktree layout, extracted into a
 * store-free module so pure transforms (default-layout-template.ts) can import
 * them without pulling in the chat/panel Zustand stores that default-layout.ts
 * depends on.
 */
export const DEFAULT_CHAT_GROUP_ID = 'group-chat';
export const DEFAULT_TERMINAL_GROUP_ID = 'group-terminal';
export const DEFAULT_ACTIVITY_GROUP_ID = 'group-activity';
export const DEFAULT_EXTRAS_GROUP_ID = 'group-extras';
export const DEFAULT_TERMINAL_PANEL_ID = 'panel-terminal';
export const DEFAULT_ACTIVITY_PANEL_ID = 'panel-activity';
export const DEFAULT_FILE_EXPLORER_PANEL_ID = 'panel-file-explorer';
