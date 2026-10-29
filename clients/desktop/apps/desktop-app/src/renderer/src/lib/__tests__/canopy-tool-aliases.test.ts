import {
  ASK_USER_TOOL_ALIASES,
  CODEX_BUILTIN_ASK_USER_TOOL_NAME,
  GET_SCRIPT_OUTPUT_TOOL_ALIASES,
  SAVE_MEMORY_TOOL_ALIASES,
  SEARCH_MEMORY_TOOL_ALIASES,
  READ_MEMORY_TOOL_ALIASES,
  SHOW_VISUAL_TOOL_ALIASES,
  PREVIEW_VISUAL_TOOL_ALIASES,
  ADD_LEDGER_ENTRY_TOOL_ALIASES,
  SEARCH_LEDGER_ENTRIES_TOOL_ALIASES,
  UPDATE_LEDGER_ENTRY_TOOL_ALIASES,
  isAskUserQuestionToolName,
  isGetScriptOutputToolName,
  isSaveMemoryToolName,
  isSearchMemoryToolName,
  isReadMemoryToolName,
  isAddLedgerEntryToolName,
  isSearchLedgerEntriesToolName,
  isUpdateLedgerEntryToolName,
  normalizeCanopyToolDisplayName,
  resolveCanopyOrBuiltinKey,
} from '../canopy-tool-aliases';

describe('canopy-tool-aliases', () => {
  describe('isAskUserQuestionToolName', () => {
    it('recognises Claude MCP, legacy, Codex dynamic and built-in ask-user names', () => {
      expect(isAskUserQuestionToolName('mcp__canopy__AskUserQuestion')).toBe(
        true,
      );
      expect(isAskUserQuestionToolName('AskUserQuestion')).toBe(true);
      expect(isAskUserQuestionToolName('canopy_ask_user_question')).toBe(true);
      expect(isAskUserQuestionToolName('request_user_input')).toBe(true);
      expect(
        isAskUserQuestionToolName(
          'mcp__canopy_pipeline_editor__AskUserQuestion',
        ),
      ).toBe(true);
      expect(
        isAskUserQuestionToolName('canopy_pipeline_editor_ask_user_question'),
      ).toBe(true);
    });

    it('rejects unrelated tool names and falsy inputs', () => {
      expect(isAskUserQuestionToolName('Bash')).toBe(false);
      expect(isAskUserQuestionToolName('GetScriptOutput')).toBe(false);
      expect(isAskUserQuestionToolName(null)).toBe(false);
      expect(isAskUserQuestionToolName(undefined)).toBe(false);
      expect(isAskUserQuestionToolName('')).toBe(false);
    });
  });

  describe('isGetScriptOutputToolName', () => {
    it('recognises Claude MCP, legacy, and Codex dynamic script-output names', () => {
      expect(isGetScriptOutputToolName('mcp__canopy__GetScriptOutput')).toBe(
        true,
      );
      expect(isGetScriptOutputToolName('GetScriptOutput')).toBe(true);
      expect(isGetScriptOutputToolName('canopy_get_script_output')).toBe(true);
    });

    it('does NOT recognise the Codex built-in ask-user tool name', () => {
      // Script output has no provider built-in equivalent — only ask-user does.
      expect(isGetScriptOutputToolName('request_user_input')).toBe(false);
    });

    it('rejects unrelated tool names and falsy inputs', () => {
      expect(isGetScriptOutputToolName('Bash')).toBe(false);
      expect(isGetScriptOutputToolName(null)).toBe(false);
      expect(isGetScriptOutputToolName(undefined)).toBe(false);
      expect(isGetScriptOutputToolName('')).toBe(false);
    });
  });

  describe('normalizeCanopyToolDisplayName', () => {
    it('folds Claude, Codex, and Cursor ShowVisual names', () => {
      for (const alias of SHOW_VISUAL_TOOL_ALIASES) {
        expect(normalizeCanopyToolDisplayName(alias)).toBe('ShowVisual');
        expect(resolveCanopyOrBuiltinKey(alias)).toBe('show_visual');
      }
    });
    it('folds Claude, Codex, and Cursor PreviewVisual names', () => {
      for (const alias of PREVIEW_VISUAL_TOOL_ALIASES) {
        expect(normalizeCanopyToolDisplayName(alias)).toBe('PreviewVisual');
        expect(resolveCanopyOrBuiltinKey(alias)).toBe('preview_visual');
      }
    });
    it('returns the canonical display name for every recognised ask-user alias', () => {
      for (const alias of ASK_USER_TOOL_ALIASES) {
        expect(normalizeCanopyToolDisplayName(alias)).toBe('AskUserQuestion');
      }
    });

    it('returns the canonical display name for every recognised script-output alias', () => {
      for (const alias of GET_SCRIPT_OUTPUT_TOOL_ALIASES) {
        expect(normalizeCanopyToolDisplayName(alias)).toBe('GetScriptOutput');
      }
    });

    it('recognises every save-memory, search-memory, and read-memory alias', () => {
      for (const alias of SAVE_MEMORY_TOOL_ALIASES) {
        expect(isSaveMemoryToolName(alias)).toBe(true);
        expect(normalizeCanopyToolDisplayName(alias)).toBe('SaveMemory');
      }
      for (const alias of SEARCH_MEMORY_TOOL_ALIASES) {
        expect(isSearchMemoryToolName(alias)).toBe(true);
        expect(normalizeCanopyToolDisplayName(alias)).toBe('SearchMemory');
      }
      for (const alias of READ_MEMORY_TOOL_ALIASES) {
        expect(isReadMemoryToolName(alias)).toBe(true);
        expect(normalizeCanopyToolDisplayName(alias)).toBe('ReadMemory');
      }
    });

    it('recognises every add-ledger-entry, search-ledger-entries, and update-ledger-entry alias', () => {
      for (const alias of ADD_LEDGER_ENTRY_TOOL_ALIASES) {
        expect(isAddLedgerEntryToolName(alias)).toBe(true);
        expect(normalizeCanopyToolDisplayName(alias)).toBe('AddFeedEntry');
      }
      for (const alias of SEARCH_LEDGER_ENTRIES_TOOL_ALIASES) {
        expect(isSearchLedgerEntriesToolName(alias)).toBe(true);
        expect(normalizeCanopyToolDisplayName(alias)).toBe('SearchFeedEntries');
      }
      for (const alias of UPDATE_LEDGER_ENTRY_TOOL_ALIASES) {
        expect(isUpdateLedgerEntryToolName(alias)).toBe(true);
        expect(normalizeCanopyToolDisplayName(alias)).toBe('UpdateFeedEntry');
      }
    });

    it('returns null for unrelated and falsy inputs', () => {
      expect(normalizeCanopyToolDisplayName('Bash')).toBeNull();
      expect(normalizeCanopyToolDisplayName(null)).toBeNull();
      expect(normalizeCanopyToolDisplayName(undefined)).toBeNull();
      expect(normalizeCanopyToolDisplayName('')).toBeNull();
    });
  });

  describe('resolveCanopyOrBuiltinKey', () => {
    it('returns the canonical key for Canopy-injected names', () => {
      expect(resolveCanopyOrBuiltinKey('mcp__canopy__AskUserQuestion')).toBe(
        'ask_user_question',
      );
      expect(resolveCanopyOrBuiltinKey('canopy_ask_user_question')).toBe(
        'ask_user_question',
      );
      expect(
        resolveCanopyOrBuiltinKey(
          'mcp__canopy_pipeline_editor__AskUserQuestion',
        ),
      ).toBe('ask_user_question');
      expect(
        resolveCanopyOrBuiltinKey('canopy_pipeline_editor_ask_user_question'),
      ).toBe('ask_user_question');
      expect(resolveCanopyOrBuiltinKey('mcp__canopy__GetScriptOutput')).toBe(
        'get_script_output',
      );
      expect(resolveCanopyOrBuiltinKey('canopy_get_script_output')).toBe(
        'get_script_output',
      );
      expect(resolveCanopyOrBuiltinKey('mcp__canopy__SaveMemory')).toBe(
        'save_memory',
      );
      expect(resolveCanopyOrBuiltinKey('canopy_search_memory')).toBe(
        'search_memory',
      );
      expect(resolveCanopyOrBuiltinKey('mcp__canopy__ReadMemory')).toBe(
        'read_memory',
      );
      expect(resolveCanopyOrBuiltinKey('mcp__canopy__AddFeedEntry')).toBe(
        'add_ledger_entry',
      );
      expect(resolveCanopyOrBuiltinKey('canopy_search_feed_entries')).toBe(
        'search_ledger_entries',
      );
      expect(resolveCanopyOrBuiltinKey('mcp__canopy__UpdateFeedEntry')).toBe(
        'update_ledger_entry',
      );
    });

    it('returns a builtin sentinel for the Codex built-in ask-user tool', () => {
      expect(
        resolveCanopyOrBuiltinKey(CODEX_BUILTIN_ASK_USER_TOOL_NAME),
      ).toEqual({ builtin: 'request_user_input' });
    });

    it('returns null for unrelated names', () => {
      expect(resolveCanopyOrBuiltinKey('Bash')).toBeNull();
      expect(resolveCanopyOrBuiltinKey(undefined)).toBeNull();
    });
  });
});

describe('Cursor MCP titles', () => {
  // The pinned Cursor CLI titles ACP tool calls on the app's MCP servers as
  // "<server>: <tool>"; the persisted block keeps that raw title and the
  // renderer folds it into the shared Canopy tool UX.
  it('folds the app server titles into canonical display names and keys', () => {
    expect(normalizeCanopyToolDisplayName('canopy: SaveMemory')).toBe(
      'SaveMemory',
    );
    expect(normalizeCanopyToolDisplayName('canopy_ui: AskUserQuestion')).toBe(
      'AskUserQuestion',
    );
    expect(resolveCanopyOrBuiltinKey('canopy: GetScriptOutput')).toBe(
      'get_script_output',
    );
    expect(isSaveMemoryToolName('canopy: SaveMemory')).toBe(true);
    expect(isSearchMemoryToolName('canopy: SearchMemory')).toBe(true);
    expect(isReadMemoryToolName('canopy: ReadMemory')).toBe(true);
    expect(isAskUserQuestionToolName('canopy_ui: AskUserQuestion')).toBe(true);
    expect(isGetScriptOutputToolName('canopy: GetScriptOutput')).toBe(true);
    expect(normalizeCanopyToolDisplayName('canopy: AddFeedEntry')).toBe(
      'AddFeedEntry',
    );
    expect(isAddLedgerEntryToolName('canopy: AddFeedEntry')).toBe(true);
    expect(isSearchLedgerEntriesToolName('canopy: SearchFeedEntries')).toBe(
      true,
    );
    expect(isUpdateLedgerEntryToolName('canopy: UpdateFeedEntry')).toBe(true);
  });

  it('leaves plugin server titles alone', () => {
    expect(normalizeCanopyToolDisplayName('linear: create_issue')).toBeNull();
    expect(resolveCanopyOrBuiltinKey('linear: SaveMemory')).toBeNull();
    expect(isSaveMemoryToolName('linear: SaveMemory')).toBe(false);
    expect(isAddLedgerEntryToolName('linear: AddFeedEntry')).toBe(false);
  });
});

describe('App Advisor Ledger names', () => {
  // App Advisor advertises the Agent Ledger tools under its own namespace. They
  // act on the same Ledger, so the renderer folds them into the same UX.
  it('folds the App Advisor Claude and Codex names into the Ledger aliases, display names and keys', () => {
    expect(
      isAddLedgerEntryToolName('mcp__canopy_app_advisor__AddFeedEntry'),
    ).toBe(true);
    expect(isAddLedgerEntryToolName('canopy_app_advisor_add_feed_entry')).toBe(
      true,
    );
    expect(
      isSearchLedgerEntriesToolName(
        'mcp__canopy_app_advisor__SearchFeedEntries',
      ),
    ).toBe(true);
    expect(
      isSearchLedgerEntriesToolName('canopy_app_advisor_search_feed_entries'),
    ).toBe(true);
    expect(
      isUpdateLedgerEntryToolName('mcp__canopy_app_advisor__UpdateFeedEntry'),
    ).toBe(true);
    expect(
      isUpdateLedgerEntryToolName('canopy_app_advisor_update_feed_entry'),
    ).toBe(true);
    expect(
      normalizeCanopyToolDisplayName('mcp__canopy_app_advisor__AddFeedEntry'),
    ).toBe('AddFeedEntry');
    expect(
      normalizeCanopyToolDisplayName('canopy_app_advisor_search_feed_entries'),
    ).toBe('SearchFeedEntries');
    expect(
      resolveCanopyOrBuiltinKey('mcp__canopy_app_advisor__UpdateFeedEntry'),
    ).toBe('update_ledger_entry');
    expect(resolveCanopyOrBuiltinKey('canopy_app_advisor_add_feed_entry')).toBe(
      'add_ledger_entry',
    );
  });

  it('keeps each App Advisor Ledger name on its own tool and leaves other App Advisor tools alone', () => {
    expect(
      isAddLedgerEntryToolName('mcp__canopy_app_advisor__SearchFeedEntries'),
    ).toBe(false);
    expect(
      isUpdateLedgerEntryToolName('canopy_app_advisor_add_feed_entry'),
    ).toBe(false);
    expect(
      normalizeCanopyToolDisplayName('mcp__canopy_app_advisor__ShowFiles'),
    ).toBeNull();
    expect(
      resolveCanopyOrBuiltinKey('canopy_app_advisor_dispatch_action'),
    ).toBeNull();
  });
});
