import { renderToStaticMarkup } from 'react-dom/server';
import { BlueprintPicker } from '../BlueprintPicker';

describe('BlueprintPicker', () => {
  it('shows curated Blueprint requirements as non-blocking setup', () => {
    const html = renderToStaticMarkup(
      <BlueprintPicker
        blueprints={[
          {
            externalId: 'blueprint-1',
            contentHash: 'a'.repeat(64),
            document: {
              version: 2,
              name: 'Issue triage',
              description: 'Triage incoming issues.',
              instructions: 'Triage issues.',
              plugins: [],
              customSkills: [],
              starterPrompts: [],
            },
            requirements: [
              {
                id: 'linear',
                kind: 'mcp',
                displayName: 'Linear',
                required: true,
                affectedSteps: [],
                setupHint: 'Connect Linear.',
              },
            ],
          },
        ]}
        loading={false}
        unavailable={false}
        selectedExternalId="blueprint-1"
        onSelect={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    expect(html).toContain('add-workspace-blueprint-requirements');
    expect(html).toContain('Linear');
    expect(html).toContain('Connect Linear.');
    expect(html).toContain('won’t stop this project template');
  });

  it('puts the explanation under the Start from heading and the selected description under the chips', () => {
    const blueprints = [
      {
        externalId: 'blueprint-1',
        contentHash: 'a'.repeat(64),
        document: {
          version: 2 as const,
          name: 'Research',
          description: 'Gathers sources.',
          instructions: 'Research.',
          plugins: [],
          customSkills: [],
          starterPrompts: [],
        },
        requirements: [],
      },
    ];
    const subtitle =
      'Sets up instructions and suggestions. You can change any of this later.';
    const unselected = renderToStaticMarkup(
      <BlueprintPicker
        blueprints={blueprints}
        loading={false}
        unavailable={false}
        selectedExternalId={null}
        onSelect={jest.fn()}
        onRetry={jest.fn()}
      />,
    );
    expect(unselected).toMatch(
      /<h3 class="[^"]*font-semibold[^"]*">Start from<\/h3><p[^>]*>Sets up instructions/,
    );
    expect(unselected).not.toContain('add-workspace-blueprint-description');
    const selected = renderToStaticMarkup(
      <BlueprintPicker
        blueprints={blueprints}
        loading={false}
        unavailable={false}
        selectedExternalId="blueprint-1"
        onSelect={jest.fn()}
        onRetry={jest.fn()}
      />,
    );
    // The subtitle stays; the description is added below the chips.
    expect(selected).toContain(subtitle);
    expect(selected).toMatch(
      /data-testid="add-workspace-blueprint-description">Gathers sources\.</,
    );
  });

  it('renders member-visible templates in a Shared with you row', () => {
    const externalId = '11111111-1111-4111-8111-111111111111';
    const html = renderToStaticMarkup(
      <BlueprintPicker
        blueprints={[]}
        sharedTemplates={[
          {
            externalId,
            sharePath: `/share/project-templates/${externalId}`,
            pinnedContentHash: 'b'.repeat(64),
            name: 'Team kickoff',
            description: 'Starts a team kickoff project.',
            audience: 'TEAM',
            owner: {
              type: 'team',
              id: '22222222-2222-4222-8222-222222222222',
              name: 'Growth',
              organization: {
                id: '33333333-3333-4333-8333-333333333333',
                name: 'Acme',
              },
            },
            createdBy: { id: 'user-2', name: 'Morgan' },
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ]}
        loading={false}
        unavailable={false}
        selectedExternalId={`shared:${externalId}`}
        onSelect={jest.fn()}
        onRetry={jest.fn()}
      />,
    );

    expect(html).toContain('Shared with you');
    expect(html).toContain('Team kickoff');
    expect(html).toContain('Starts a team kickoff project.');
  });
});
