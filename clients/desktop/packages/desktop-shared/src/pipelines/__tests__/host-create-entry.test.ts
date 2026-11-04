import {
  CREATE_ENTRY_TITLE_MAX,
  emptyCreateBotEntryOutputs,
  emptyCreateProjectEntryOutputs,
  parseCreateBotEntryInputs,
  parseCreateProjectEntryInputs,
} from '../host-create-entry';

describe('parseCreateProjectEntryInputs', () => {
  it('parses a project with a trimmed title and group', () => {
    expect(
      parseCreateProjectEntryInputs({
        project_id: 'cowork-default',
        title: '  Nightly  ',
        group: ' Reports ',
      }),
    ).toEqual({
      ok: true,
      value: {
        projectId: 'cowork-default',
        title: 'Nightly',
        group: 'Reports',
      },
    });
  });

  it('accepts an organization Chats project id', () => {
    expect(
      parseCreateProjectEntryInputs({
        project_id: 'cowork-org-5b1d7c1e-8d0b-4d39-9a52-2f7e0b5f9b11',
      }).ok,
    ).toBe(true);
  });

  it('requires project_id', () => {
    expect(parseCreateProjectEntryInputs({})).toEqual({
      ok: false,
      message: 'create-project-entry requires "project_id"',
    });
  });

  it('rejects an unsafe project id', () => {
    expect(parseCreateProjectEntryInputs({ project_id: 'Bad Id' })).toEqual({
      ok: false,
      message:
        'create-project-entry "project_id" must be lowercase alphanumeric with hyphens',
    });
  });

  it('treats a whitespace-only title and group as absent', () => {
    expect(
      parseCreateProjectEntryInputs({
        project_id: 'p',
        title: '   ',
        group: ' ',
      }),
    ).toEqual({ ok: true, value: { projectId: 'p' } });
  });

  it('accepts a title at exactly the limit after trimming', () => {
    const title = `  ${'x'.repeat(CREATE_ENTRY_TITLE_MAX)}  `;
    expect(parseCreateProjectEntryInputs({ project_id: 'p', title }).ok).toBe(
      true,
    );
  });

  it('rejects a title over the limit without echoing it', () => {
    const title = 'x'.repeat(CREATE_ENTRY_TITLE_MAX + 1);
    const parsed = parseCreateProjectEntryInputs({ project_id: 'p', title });
    expect(parsed).toEqual({
      ok: false,
      message: 'create-project-entry "title" must be at most 200 characters',
    });
    expect(JSON.stringify(parsed)).not.toContain('xxxxx');
  });

  // CAN-5479: creating never removes a group, so `none` is a name like any
  // other; only move-to-group reads it as "remove".
  it('joins a group named None', () => {
    expect(
      parseCreateProjectEntryInputs({ project_id: 'p', group: 'None' }),
    ).toEqual({ ok: true, value: { projectId: 'p', group: 'None' } });
  });
});

describe('parseCreateBotEntryInputs', () => {
  it('defaults bot_id to app_advisor', () => {
    expect(parseCreateBotEntryInputs({})).toEqual({
      ok: true,
      value: { botId: 'app_advisor' },
    });
  });

  it('keeps an explicit bot id with underscores', () => {
    expect(
      parseCreateBotEntryInputs({ bot_id: 'app_advisor', group: 'Ops' }),
    ).toEqual({ ok: true, value: { botId: 'app_advisor', group: 'Ops' } });
  });

  it('rejects an unsafe bot id', () => {
    expect(parseCreateBotEntryInputs({ bot_id: 'App Advisor' }).ok).toBe(false);
  });

  it('applies the same title and group rules as the project step', () => {
    expect(
      parseCreateBotEntryInputs({
        title: 'x'.repeat(CREATE_ENTRY_TITLE_MAX + 1),
      }),
    ).toEqual({
      ok: false,
      message: 'create-bot-entry "title" must be at most 200 characters',
    });
    expect(parseCreateBotEntryInputs({ group: 'none' })).toEqual({
      ok: true,
      value: { botId: 'app_advisor', group: 'none' },
    });
  });
});

it('empty outputs carry every declared output', () => {
  expect(emptyCreateProjectEntryOutputs()).toEqual({
    project_id: '',
    task_id: '',
    chat_id: '',
    task_created: 'false',
    chat_created: 'false',
    group_id: '',
    group_created: 'false',
    grouped: 'false',
    not_grouped_reason: '',
  });
  expect(Object.keys(emptyCreateBotEntryOutputs())).toContain('bot_id');
  expect(Object.keys(emptyCreateBotEntryOutputs())).not.toContain('project_id');
});
