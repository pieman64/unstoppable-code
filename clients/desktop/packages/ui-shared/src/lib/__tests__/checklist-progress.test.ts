import {
  checklistProgress,
  countsProjectStep,
  retainChecklistProjectStep,
  type ChecklistProgress,
} from '../checklist-progress';

interface Entry {
  id: string;
  resolved: boolean;
  /** Counts only while pending, like the examples preview. */
  contextual?: boolean;
  /** Never counts, like a repository lesson with no repository. */
  inapplicable?: boolean;
}

function progress(entries: Entry[]): ChecklistProgress<Entry> {
  return checklistProgress({
    entries,
    isResolved: (entry) => entry.resolved,
    isCounted: (entry) =>
      entry.inapplicable !== true &&
      !(entry.contextual === true && entry.resolved),
  });
}

const ids = (entries: readonly Entry[]): string[] =>
  entries.map((entry) => entry.id);

describe('retainChecklistProjectStep', () => {
  it.each([
    [false, false, false, true],
    [true, true, false, true],
    [true, false, true, true],
    [true, false, false, false],
  ])(
    'retains project step for nontechnical=%s, hasProject=%s, resolved=%s: %s',
    (nontechnical, hasProject, resolved, expected) => {
      expect(
        retainChecklistProjectStep({ nontechnical, hasProject, resolved }),
      ).toBe(expected);
    },
  );
});

describe('countsProjectStep', () => {
  it.each([
    [false, false, true],
    [true, true, true],
    [false, true, true],
    [true, false, false],
  ])(
    'counts the project step for satisfied=%s, recorded=%s: %s',
    (satisfied, recorded, expected) => {
      expect(countsProjectStep({ satisfied, recorded })).toBe(expected);
    },
  );
});

describe('checklistProgress', () => {
  it('numbers done steps first and remaining steps after, in list order', () => {
    const entries: Entry[] = [
      { id: 'roles', resolved: true },
      { id: 'add-repo', resolved: true },
      { id: 'tools', resolved: false },
      { id: 'agents', resolved: false },
      { id: 'notifications', resolved: true },
      { id: 'tour', resolved: false },
    ];
    const result = progress(entries);
    expect(ids(result.order)).toEqual([
      'roles',
      'add-repo',
      'notifications',
      'tools',
      'agents',
      'tour',
    ]);
    expect(result.total).toBe(6);
    // The first remaining step is "done + 1", so finishing steps in order
    // moves the counter by exactly one each time.
    expect(result.stepNumber(entries[2])).toBe(4);
    expect(result.stepNumber(entries[4])).toBe(3);
    expect(result.stepNumber(entries[0])).toBe(1);
  });

  it('walks Back and Next through the same order the numbers use', () => {
    const entries: Entry[] = [
      { id: 'roles', resolved: true },
      { id: 'tools', resolved: false },
      { id: 'notifications', resolved: true },
      { id: 'tour', resolved: false },
    ];
    const result = progress(entries);
    expect(result.previous(entries[1])?.id).toBe('notifications');
    expect(result.previous(entries[2])?.id).toBe('roles');
    expect(result.previous(entries[0])).toBeUndefined();
    expect(result.next(entries[0])?.id).toBe('notifications');
    expect(result.next(entries[2])?.id).toBe('tools');
    expect(result.next(entries[3])).toBeUndefined();
  });

  it('leaves an uncounted entry out of the numbers and the navigation', () => {
    const entries: Entry[] = [
      { id: 'roles', resolved: true },
      { id: 'tools', resolved: true },
      { id: 'examples', resolved: true, contextual: true },
      { id: 'agents', resolved: false },
      { id: 'plan', resolved: true, inapplicable: true },
      { id: 'tour', resolved: false },
    ];
    const result = progress(entries);
    expect(ids(result.order)).toEqual(['roles', 'tools', 'agents', 'tour']);
    expect(result.total).toBe(4);
    expect(result.stepNumber(entries[3])).toBe(3);
    expect(result.previous(entries[3])?.id).toBe('tools');
    expect(result.next(entries[1])?.id).toBe('agents');
    // Shown anyway (Back from a step it used to precede), it borrows the
    // next remaining step's number rather than moving the counter back.
    expect(result.stepNumber(entries[2])).toBe(3);
    expect(result.stepNumber(entries[4])).toBe(3);
    expect(result.previous(entries[2])).toBeUndefined();
    expect(result.next(entries[4])).toBeUndefined();
  });

  it('counts a contextual entry while it is still pending', () => {
    const entries: Entry[] = [
      { id: 'roles', resolved: true },
      { id: 'tools', resolved: true },
      { id: 'examples', resolved: false, contextual: true },
      { id: 'agents', resolved: false },
    ];
    const result = progress(entries);
    expect(result.total).toBe(4);
    expect(result.stepNumber(entries[2])).toBe(3);
    expect(result.stepNumber(entries[3])).toBe(4);
  });

  it('clamps the borrowed number when every counted step is done', () => {
    const entries: Entry[] = [
      { id: 'roles', resolved: true },
      { id: 'tour', resolved: true },
      { id: 'mobile', resolved: true, contextual: true },
    ];
    const result = progress(entries);
    expect(result.total).toBe(2);
    expect(result.stepNumber(entries[2])).toBe(2);
  });

  it('handles an empty checklist', () => {
    const result = progress([]);
    expect(result.order).toEqual([]);
    expect(result.total).toBe(0);
  });
});
