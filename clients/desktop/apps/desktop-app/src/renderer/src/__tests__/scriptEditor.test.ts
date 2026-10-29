import {
  SCRIPT_ENV_VISIBLE_VAR_DEFINITIONS,
  createScriptEnvVarToken,
} from '@canopy/desktop-shared/scripts';
import {
  createScriptEnvVarInsertion,
  insertTextAtSelection,
} from '../lib/scriptEditor';

describe('scriptEditor helpers', () => {
  it('exposes the expected script env vars without the hidden alias', () => {
    expect(
      SCRIPT_ENV_VISIBLE_VAR_DEFINITIONS.map((definition) => definition.name),
    ).toEqual([
      'CANOPY_WORKSPACE_ID',
      'CANOPY_WORKTREE_NAME',
      'CANOPY_WORKTREE_DATA_DIR',
      'CANOPY_WORKSPACE_CHILD_REPO_ID',
    ]);
  });

  it('formats script env var insertions for commands', () => {
    expect(createScriptEnvVarToken('CANOPY_WORKTREE_NAME')).toBe(
      '$CANOPY_WORKTREE_NAME',
    );
    expect(createScriptEnvVarInsertion('CANOPY_WORKTREE_NAME')).toBe(
      '$CANOPY_WORKTREE_NAME',
    );
  });

  it('inserts script variables at the current selection', () => {
    expect(
      insertTextAtSelection({
        value: 'echo ',
        insertedText: '$CANOPY_WORKTREE_NAME',
        selectionStart: 5,
        selectionEnd: 5,
      }),
    ).toEqual({
      value: 'echo $CANOPY_WORKTREE_NAME',
      cursorPosition: 26,
    });
  });
});
