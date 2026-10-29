const mockConstructLinearClient = jest.fn<unknown, [{ apiKey: string }]>();

jest.mock('@linear/sdk', () => ({
  LinearClient: function MockLinearClient(options: {
    apiKey: string;
  }): unknown {
    return mockConstructLinearClient(options);
  },
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetRunDir } from '../_lib/output';
import {
  extractTicketIdentifier,
  runReadLinearTicketAction,
} from '../read-linear-ticket/runner';

interface OutputMap {
  [key: string]: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObjectJson(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error('Expected JSON object');
  }
  return parsed;
}

function readOutputs(filePath: string): OutputMap {
  return Object.fromEntries(
    fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe('read-linear-ticket builtin action', () => {
  const originalCwd = process.cwd();
  let tempDir: string;
  let outputFile: string;

  beforeEach(() => {
    resetRunDir();
    jest.clearAllMocks();
    mockConstructLinearClient.mockReset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-linear-ticket-'));
    outputFile = path.join(tempDir, 'canopy-output.txt');
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('extracts ticket identifiers from direct ids and flexible urls', () => {
    expect(extractTicketIdentifier('api-1978')).toBe('API-1978');
    expect(
      extractTicketIdentifier(
        'https://linear.app/unstoppable-domains/issue/API-1978/renewal-handling-job',
      ),
    ).toBe('API-1978');
    expect(
      extractTicketIdentifier(
        'www.linear.app/workspace/issue/api-1978/renewal-handling-job',
      ),
    ).toBe('API-1978');
    expect(extractTicketIdentifier('linear.app/workspace/issue/API-1978')).toBe(
      'API-1978',
    );
  });

  it('throws a clear error when CANOPY_LINEAR_API_KEY is missing', async () => {
    await expect(
      runReadLinearTicketAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_TICKET_ID: 'API-1978',
      }),
    ).rejects.toThrow(
      'CANOPY_LINEAR_API_KEY is required to use builtin/read-linear-ticket',
    );
  });

  it('fetches a Linear ticket and emits structured outputs', async () => {
    const fakeIssue = {
      id: 'issue-1',
      identifier: 'API-1978',
      number: 1978,
      title: 'Renewal handling job',
      description: 'Investigate renewal handling.\nCoordinate rollout.',
      url: 'https://linear.app/unstoppable-domains/issue/API-1978/renewal-handling-job',
      branchName: 'api-1978-renewal-handling-job',
      customerTicketCount: 2,
      labelIds: ['label-1', 'label-2'],
      previousIdentifiers: ['PLAT-77'],
      priority: 2,
      priorityLabel: 'High',
      estimate: 5,
      dueDate: '2026-04-01',
      createdAt: new Date('2026-03-20T10:00:00.000Z'),
      updatedAt: new Date('2026-03-24T12:34:56.000Z'),
      startedAt: new Date('2026-03-21T09:00:00.000Z'),
      completedAt: null,
      canceledAt: null,
      archivedAt: null,
      autoArchivedAt: null,
      autoClosedAt: null,
      assignee: Promise.resolve({
        id: 'user-1',
        name: 'Jane Doe',
        displayName: 'jane',
        email: 'jane@example.com',
        active: true,
        url: 'https://linear.app/unstoppable-domains/user/jane',
      }),
      creator: Promise.resolve({
        id: 'user-2',
        name: 'John Smith',
        displayName: 'john',
        email: 'john@example.com',
        active: true,
        url: 'https://linear.app/unstoppable-domains/user/john',
      }),
      state: Promise.resolve({
        id: 'state-1',
        name: 'In Progress',
        type: 'started',
        color: '#abcdef',
        description: 'Work has started',
      }),
      team: Promise.resolve({
        id: 'team-1',
        key: 'API',
        name: 'API',
        displayName: 'API Team',
        description: 'API work',
        color: '#123456',
        icon: 'bolt',
      }),
      project: Promise.resolve({
        id: 'project-1',
        name: 'Renewals',
        description: 'Renewal platform improvements',
        url: 'https://linear.app/unstoppable-domains/project/renewals',
        slugId: 'renewals',
        state: 'planned',
        progress: 0.5,
        priority: 2,
        priorityLabel: 'High',
        color: '#654321',
        icon: 'refresh',
        startDate: '2026-03-18',
        targetDate: '2026-04-10',
        startedAt: new Date('2026-03-18T00:00:00.000Z'),
        completedAt: null,
        canceledAt: null,
        updatedAt: new Date('2026-03-24T11:00:00.000Z'),
        status: Promise.resolve({
          id: 'project-status-1',
          name: 'On Track',
          type: 'onTrack',
          color: '#00ff00',
          description: 'Healthy progress',
        }),
      }),
      cycle: Promise.resolve({
        id: 'cycle-1',
        name: 'Sprint 12',
        number: 12,
        startsAt: new Date('2026-03-17T00:00:00.000Z'),
        endsAt: new Date('2026-03-31T00:00:00.000Z'),
        completedAt: null,
        isActive: true,
        isFuture: false,
        isPast: false,
        progress: 0.65,
      }),
      parent: Promise.resolve({
        id: 'issue-parent-1',
        identifier: 'API-1900',
        title: 'Renewals epic',
        url: 'https://linear.app/unstoppable-domains/issue/API-1900/renewals-epic',
      }),
      labels: jest.fn().mockResolvedValue({
        nodes: [
          {
            id: 'label-1',
            name: 'backend',
            color: '#111111',
            description: 'Backend work',
            isGroup: false,
          },
          {
            id: 'label-2',
            name: 'payments',
            color: '#222222',
            description: null,
            isGroup: false,
          },
        ],
      }),
    };

    const clientInstance = {
      searchIssues: jest.fn<
        Promise<{
          nodes: Array<{
            id: string;
            identifier: string;
            previousIdentifiers: string[];
          }>;
        }>,
        [string]
      >(),
      issue: jest.fn<Promise<typeof fakeIssue>, [string]>(),
    };

    clientInstance.searchIssues.mockResolvedValue({
      nodes: [
        {
          id: 'issue-1',
          identifier: 'API-1978',
          previousIdentifiers: [],
        },
      ],
    });
    clientInstance.issue.mockResolvedValue(fakeIssue);
    mockConstructLinearClient.mockImplementation(() => clientInstance);

    await runReadLinearTicketAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_LINEAR_API_KEY: 'lin_api_test',
      INPUT_TICKET_ID:
        'https://linear.app/unstoppable-domains/issue/API-1978/renewal-handling-job',
    });

    expect(clientInstance.searchIssues).toHaveBeenCalledWith('API-1978');
    expect(clientInstance.issue).toHaveBeenCalledWith('issue-1');

    const outputs = readOutputs(outputFile);
    expect(outputs.ticket_id).toBe('API-1978');
    expect(outputs.title).toBe('Renewal handling job');
    expect(outputs.status).toBe('In Progress');
    expect(outputs.priority).toBe('High');
    expect(outputs.assignee).toBe('jane');
    expect(outputs.project).toBe('Renewals');
    expect(outputs.team_key).toBe('API');
    expect(outputs.labels).toBe(JSON.stringify(['backend', 'payments']));
    expect(outputs.status_json).toContain('"name":"In Progress"');
    expect(outputs.project_json).toContain('"name":"Renewals"');
    expect(outputs.team_json).toContain('"key":"API"');

    const details = parseObjectJson(outputs.details_json);
    expect(details.title).toBe('Renewal handling job');

    const project = details.project;
    expect(isRecord(project) ? project.name : null).toBe('Renewals');

    const labels = details.labels;
    expect(
      Array.isArray(labels)
        ? labels.filter(isRecord).map((label) => label.name)
        : null,
    ).toEqual(['backend', 'payments']);

    const detailsFile = parseObjectJson(
      fs.readFileSync(outputs.details_json_file, 'utf8'),
    );
    expect(detailsFile.ticket_id).toBe('API-1978');

    const status = detailsFile.status;
    expect(isRecord(status) ? status.name : null).toBe('In Progress');

    const summary = fs.readFileSync(outputs.summary_file, 'utf8');
    expect(summary).toContain('# Linear Ticket');
    expect(summary).toContain('Renewal handling job');
    expect(summary).toContain('backend, payments');
  });

  function setupMinimalClient(): void {
    const clientInstance = {
      searchIssues: jest.fn().mockResolvedValue({
        nodes: [
          { id: 'issue-1', identifier: 'API-1', previousIdentifiers: [] },
        ],
      }),
      issue: jest.fn().mockResolvedValue({
        identifier: 'API-1',
        id: 'issue-1',
        number: 1,
        title: 'T',
        description: null,
        url: 'https://linear.app/x/issue/API-1',
        priority: 0,
        priorityLabel: 'No priority',
        branchName: 'b',
        estimate: null,
        dueDate: null,
        customerTicketCount: 0,
        labelIds: [],
        previousIdentifiers: [],
        createdAt: new Date(0),
        updatedAt: new Date(0),
        labels: jest.fn().mockResolvedValue({ nodes: [] }),
      }),
    };
    mockConstructLinearClient.mockImplementation(() => clientInstance);
  }

  it('ignores runtime Linear base URL env and passes only apiKey in production', async () => {
    setupMinimalClient();
    await runReadLinearTicketAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_LINEAR_API_KEY: 'lin_api_test',
      CANOPY_LINEAR_API_BASE_URL: 'http://127.0.0.1:4011/graphql',
      INPUT_TICKET_ID: 'API-1',
    });
    expect(mockConstructLinearClient).toHaveBeenCalledWith({
      apiKey: 'lin_api_test',
    });
  });
});
