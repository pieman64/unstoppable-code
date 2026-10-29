import { searchAppAdvisorActions } from '../app-advisor-actions';

// The searchable catalog names the cost panels on `panel.add_tab`, with the
// chat binding the Session breakdown needs. Neither needs Early access.
describe('App Advisor action catalog — cost panels', () => {
  const addTab = (): ReturnType<
    typeof searchAppAdvisorActions
  >['actions'][number] => {
    const entry = searchAppAdvisorActions({ actionType: 'panel.add_tab' })
      .actions[0];
    if (entry === undefined) throw new Error('panel.add_tab missing');
    return entry;
  };

  it('lists both kinds and the chatId binding', () => {
    const entry = addTab();
    const kind = entry.fields.find((field) => field.name === 'kind');
    expect(kind?.type).toContain("'cost'");
    expect(kind?.type).toContain("'session-breakdown'");
    expect(entry.optionalFields).toContain('chatId');
    const costNote = entry.notes?.find((note) => note.includes("'cost'"));
    expect(costNote).toContain('requires chatId');
    expect(costNote).not.toMatch(/Early access/);
  });

  it('is found by cost searches', () => {
    for (const query of ['open the cost panel', 'session breakdown']) {
      expect(
        searchAppAdvisorActions({ query }).actions.map((action) => action.type),
      ).toContain('panel.add_tab');
    }
  });
});
