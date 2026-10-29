import {
  WORKFLOW_EDIT_MENU_ACTIONS,
  WORKFLOW_EDIT_SAVE_STATE_LABELS,
  WORKFLOW_EDIT_SECTION_LABELS,
  WORKFLOW_EDIT_SECTIONS,
  resolveWorkflowEditPlan,
  type WorkflowEditActionId,
  type WorkflowEditPlan,
  type WorkflowEditPlanInput,
} from '../edit-shell';

const DESKTOP = { pipelines: 'execute', automations: true } as const;

function plan(
  overrides: Partial<WorkflowEditPlanInput> = {},
): WorkflowEditPlan {
  return resolveWorkflowEditPlan({
    kind: 'automation',
    readOnly: false,
    dirty: false,
    saving: false,
    draft: false,
    canSubmit: true,
    userOwned: true,
    capabilities: DESKTOP,
    ...overrides,
  });
}

function visibleActions(result: WorkflowEditPlan): WorkflowEditActionId[] {
  const ids: WorkflowEditActionId[] = [
    'delete',
    'duplicate',
    'run',
    'toggle',
    'share',
    'save',
  ];
  return ids.filter((id) => result.actions[id].visible);
}

describe('workflow edit constants', () => {
  it('lists the sections in tab order with their labels', () => {
    expect(WORKFLOW_EDIT_SECTIONS).toEqual(['definition', 'trigger', 'runs']);
    expect(
      WORKFLOW_EDIT_SECTIONS.map((s) => WORKFLOW_EDIT_SECTION_LABELS[s]),
    ).toEqual(['Definition', 'Trigger', 'Runs']);
  });

  it('labels every save state, with nothing for a saved item', () => {
    expect(WORKFLOW_EDIT_SAVE_STATE_LABELS).toEqual({
      new: 'New',
      'read-only': 'Read-only',
      unsaved: 'Unsaved changes',
      saving: 'Saving…',
      saved: null,
    });
  });
});

describe('resolveWorkflowEditPlan', () => {
  describe('Save', () => {
    it('is the primary action on an editable item, disabled while clean', () => {
      const result = plan();
      expect(result.primary).toBe('save');
      expect(result.actions.save).toEqual({ visible: true, disabled: true });
    });

    it('is enabled once a saved item is dirty and can be submitted', () => {
      expect(plan({ dirty: true }).actions.save.disabled).toBe(false);
    });

    it('is disabled while saving or when the form cannot be submitted', () => {
      expect(plan({ dirty: true, saving: true }).actions.save.disabled).toBe(
        true,
      );
      expect(
        plan({ dirty: true, canSubmit: false }).actions.save.disabled,
      ).toBe(true);
    });

    it('can save a clean never-saved draft that can be submitted', () => {
      expect(plan({ draft: true }).actions.save.disabled).toBe(false);
      expect(
        plan({ draft: true, canSubmit: false }).actions.save.disabled,
      ).toBe(true);
    });

    it('is hidden on a read-only item', () => {
      expect(plan({ readOnly: true }).actions.save.visible).toBe(false);
    });
  });

  describe('dirty-gated actions', () => {
    it('disables Run, Share and Duplicate while dirty, with a reason each', () => {
      const result = plan({ kind: 'pipeline', userOwned: false, dirty: true });
      expect(result.actions.run).toEqual({
        visible: true,
        disabled: true,
        reason: 'Save to run the latest changes',
      });
      expect(result.actions.share).toEqual({
        visible: true,
        disabled: true,
        reason: 'Save to share the latest changes',
      });
      expect(result.actions.duplicate).toEqual({
        visible: true,
        disabled: true,
        reason: 'Save to duplicate the latest changes',
      });
    });

    it('disables them without a reason while saving', () => {
      const result = plan({ kind: 'pipeline', userOwned: false, saving: true });
      for (const id of ['run', 'share', 'duplicate'] as const) {
        expect(result.actions[id]).toEqual({ visible: true, disabled: true });
      }
    });

    it('enables them on a clean saved item', () => {
      const result = plan({ kind: 'pipeline', userOwned: false });
      for (const id of ['run', 'share', 'duplicate'] as const) {
        expect(result.actions[id]).toEqual({ visible: true, disabled: false });
      }
    });
  });

  describe('Duplicate', () => {
    it('is the primary action on a read-only pipeline', () => {
      const result = plan({
        kind: 'pipeline',
        readOnly: true,
        userOwned: false,
      });
      expect(result.primary).toBe('duplicate');
      expect(result.actions.duplicate).toEqual({
        visible: true,
        disabled: false,
      });
      expect(visibleActions(result)).toEqual(['duplicate', 'share']);
    });

    it('is a secondary action on an editable pipeline the user does not own', () => {
      const result = plan({ kind: 'pipeline', userOwned: false });
      expect(result.primary).toBe('save');
      expect(visibleActions(result)).toEqual([
        'delete',
        'duplicate',
        'run',
        'toggle',
        'share',
        'save',
      ]);
    });

    it("is hidden on the user's own pipeline and on automations", () => {
      expect(plan({ kind: 'pipeline' }).actions.duplicate.visible).toBe(false);
      expect(plan({ userOwned: false }).actions.duplicate.visible).toBe(false);
    });

    it('is hidden on a pipeline draft', () => {
      expect(
        plan({ kind: 'pipeline', userOwned: false, draft: true }).actions
          .duplicate.visible,
      ).toBe(false);
    });
  });

  it('shows only Duplicate on a read-only shared automation', () => {
    const result = plan({ readOnly: true });
    expect(result.primary).toBe('duplicate');
    expect(visibleActions(result)).toEqual(['duplicate']);
    expect(result.saveState).toBe('read-only');
  });

  describe('drafts', () => {
    it('keep Run and Share in place on a draft, disabled until it is saved', () => {
      for (const kind of ['automation', 'pipeline'] as const) {
        const result = plan({ kind, draft: true });
        expect(visibleActions(result)).toEqual(['run', 'share', 'save']);
        expect(result.actions.run).toEqual({
          visible: true,
          disabled: true,
          reason: 'Save it first to run it',
        });
        expect(result.actions.share).toEqual({
          visible: true,
          disabled: true,
          reason: 'Save it first to share it',
        });
      }
    });

    it('hide the toggle, which an automation draft sets in its form', () => {
      expect(plan({ draft: true }).actions.toggle.visible).toBe(false);
      expect(
        plan({ kind: 'pipeline', draft: true }).actions.toggle.visible,
      ).toBe(false);
    });

    it('hide Delete and Duplicate', () => {
      const result = plan({ kind: 'pipeline', userOwned: false, draft: true });
      expect(result.actions.delete.visible).toBe(false);
      expect(result.actions.duplicate.visible).toBe(false);
    });

    it('still hide Run and Share where they never apply', () => {
      const result = plan({ draft: true, runnable: false, shareable: false });
      expect(visibleActions(result)).toEqual(['save']);
    });
  });

  describe('menu actions', () => {
    it('lists the actions the More menu holds, in menu order', () => {
      expect(WORKFLOW_EDIT_MENU_ACTIONS).toEqual([
        'toggle',
        'duplicate',
        'delete',
      ]);
    });
  });

  describe('Run', () => {
    it('needs pipeline execution for a pipeline', () => {
      expect(plan({ kind: 'pipeline' }).actions.run.visible).toBe(true);
      for (const pipelines of ['crud-only', 'read-only'] as const) {
        expect(
          plan({
            kind: 'pipeline',
            capabilities: { pipelines, automations: true },
          }).actions.run.visible,
        ).toBe(false);
      }
    });

    it('needs the automations capability for an automation', () => {
      expect(
        plan({ capabilities: { pipelines: 'execute', automations: false } })
          .actions.run.visible,
      ).toBe(false);
      expect(
        plan({ capabilities: { pipelines: 'execute' } }).actions.run.visible,
      ).toBe(false);
    });

    it('is hidden when the item is not runnable, or read-only', () => {
      expect(plan({ runnable: false }).actions.run.visible).toBe(false);
      expect(
        plan({ kind: 'pipeline', readOnly: true }).actions.run.visible,
      ).toBe(false);
    });
  });

  describe('Share', () => {
    it('is hidden when the item is not shareable', () => {
      expect(plan({ shareable: false }).actions.share.visible).toBe(false);
    });

    it('stays on a read-only pipeline', () => {
      expect(
        plan({ kind: 'pipeline', readOnly: true }).actions.share.visible,
      ).toBe(true);
    });
  });

  describe('Delete', () => {
    it('is hidden on read-only items and disabled while saving', () => {
      expect(plan({ readOnly: true }).actions.delete.visible).toBe(false);
      expect(plan({ saving: true }).actions.delete).toEqual({
        visible: true,
        disabled: true,
      });
      expect(plan({ dirty: true }).actions.delete).toEqual({
        visible: true,
        disabled: false,
      });
    });

    it('is hidden when the item cannot be deleted', () => {
      expect(plan({ deletable: false }).actions.delete.visible).toBe(false);
    });
  });

  describe('toggle', () => {
    it('is hidden on read-only items', () => {
      expect(plan({ readOnly: true }).actions.toggle.visible).toBe(false);
      expect(
        plan({ kind: 'pipeline', readOnly: true }).actions.toggle.visible,
      ).toBe(false);
    });

    it('stays enabled on a dirty saved item and is disabled while saving', () => {
      expect(plan({ dirty: true }).actions.toggle).toEqual({
        visible: true,
        disabled: false,
      });
      expect(plan({ saving: true }).actions.toggle).toEqual({
        visible: true,
        disabled: true,
      });
    });
  });

  describe('saveState', () => {
    it.each([
      [{ readOnly: true, dirty: true, saving: true }, 'read-only'],
      [{ saving: true, draft: true, dirty: true }, 'saving'],
      [{ draft: true, dirty: true }, 'new'],
      [{ dirty: true }, 'unsaved'],
      [{}, 'saved'],
    ] as const)('%o is %s', (overrides, expected) => {
      expect(plan(overrides).saveState).toBe(expected);
    });
  });
});
