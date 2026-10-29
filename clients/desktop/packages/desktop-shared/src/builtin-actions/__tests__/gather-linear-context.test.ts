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
import { runGatherLinearContextAction } from '../gather-linear-context/runner';

interface OutputMap {
  [key: string]: string;
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

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

function makeIssue(identifier: string): {
  id: string;
  identifier: string;
  number: number;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  priorityLabel: string;
  branchName: string;
  estimate: null;
  dueDate: null;
  customerTicketCount: number;
  labelIds: string[];
  previousIdentifiers: string[];
  createdAt: Date;
  updatedAt: Date;
  labels: jest.Mock<Promise<{ nodes: [] }>, []>;
  team: Promise<{
    id: string;
    key: string;
    name: string;
    displayName: string;
  }>;
  state: Promise<{
    id: string;
    name: string;
    type: string;
    color: string;
  }>;
} {
  const [prefix = 'API', number = '1'] = identifier.split('-');
  const labels = jest.fn<Promise<{ nodes: [] }>, []>();
  labels.mockResolvedValue({ nodes: [] });

  return {
    id: `issue-${identifier}`,
    identifier,
    number: Number.parseInt(number, 10),
    title: `${identifier} title`,
    description: `Description for ${identifier}`,
    url: `https://linear.app/example/issue/${identifier}`,
    priority: 0,
    priorityLabel: 'No priority',
    branchName: `${identifier.toLowerCase()}-branch`,
    estimate: null,
    dueDate: null,
    customerTicketCount: 0,
    labelIds: [],
    previousIdentifiers: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    labels,
    team: Promise.resolve({
      id: `team-${prefix}`,
      key: prefix,
      name: `${prefix} Team`,
      displayName: `${prefix} Team`,
    }),
    state: Promise.resolve({
      id: 'state-1',
      name: 'Todo',
      type: 'unstarted',
      color: '#cccccc',
    }),
  };
}

describe('gather-linear-context builtin action', () => {
  const originalCwd = process.cwd();
  let tempDir: string;
  let outputFile: string;
  let prJsonFile: string;

  beforeEach(() => {
    resetRunDir();
    jest.clearAllMocks();
    mockConstructLinearClient.mockReset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-linear-context-'));
    outputFile = path.join(tempDir, 'canopy-output.txt');
    prJsonFile = path.join(tempDir, 'pr.json');
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('validates detected ticket prefixes against the Linear team list before fetching details', async () => {
    fs.writeFileSync(
      prJsonFile,
      JSON.stringify({
        pr: {
          title: 'Fix API-12 and ignore NOPE-9',
          body: 'Related to PLAT-77 and API-12.',
        },
      }),
      'utf8',
    );

    const searchIssues = jest.fn<
      Promise<{
        nodes: Array<{
          id: string;
          identifier: string;
          previousIdentifiers: string[];
        }>;
      }>,
      [string]
    >((term) =>
      Promise.resolve({
        nodes: [
          { id: `issue-${term}`, identifier: term, previousIdentifiers: [] },
        ],
      }),
    );
    const issue = jest.fn<Promise<ReturnType<typeof makeIssue>>, [string]>(
      (id) => Promise.resolve(makeIssue(id.replace(/^issue-/, ''))),
    );
    mockConstructLinearClient.mockImplementation(() => ({
      teams: jest.fn().mockResolvedValue({
        nodes: [
          { id: 'team-api', key: 'API', name: 'API Team' },
          { id: 'team-plat', key: 'PLAT', name: 'Platform Team' },
        ],
      }),
      searchIssues,
      issue,
    }));

    await runGatherLinearContextAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_LINEAR_API_KEY: 'lin_api_test',
      INPUT_CURRENT_BRANCH: 'feature/api-12-branch',
      INPUT_PR_JSON_FILE: prJsonFile,
    });

    expect(searchIssues).toHaveBeenCalledTimes(2);
    expect(searchIssues).toHaveBeenCalledWith('API-12');
    expect(searchIssues).toHaveBeenCalledWith('PLAT-77');
    expect(searchIssues).not.toHaveBeenCalledWith('NOPE-9');

    const outputs = readOutputs(outputFile);
    expect(JSON.parse(outputs.detected_ticket_ids_json)).toEqual([
      'API-12',
      'PLAT-77',
    ]);
    expect(outputs.ticket_count).toBe('2');
    expect(outputs.team_list_fetched).toBe('true');
    expect(JSON.parse(outputs.valid_team_prefixes_json)).toEqual([
      'API',
      'PLAT',
    ]);

    const invalidCandidates = parseJson(outputs.invalid_ticket_candidates_json);
    expect(invalidCandidates).toEqual([
      {
        id: 'NOPE-9',
        prefix: 'NOPE',
        extractionSources: ['title'],
        reason: 'invalid_prefix',
      },
    ]);

    const context = readJsonFile(outputs.linear_context_file);
    expect(context).toMatchObject({
      detectedTicketIds: ['API-12', 'PLAT-77'],
      candidateTicketIds: ['API-12', 'NOPE-9', 'PLAT-77'],
      hasLinearToken: true,
      teamListFetched: true,
    });
    const summary = fs.readFileSync(outputs.linear_summary_file, 'utf8');
    expect(summary).toContain('Validated Linear tickets: API-12, PLAT-77');
    expect(summary).toContain('Rejected ticket-shaped candidates: NOPE-9');
    expect(summary).toContain('Description for API-12');
  });

  it('does not fetch candidate tickets when no Linear token is available', async () => {
    fs.writeFileSync(
      prJsonFile,
      JSON.stringify({ pr: { title: 'API-12', body: '' } }),
      'utf8',
    );

    await runGatherLinearContextAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_CURRENT_BRANCH: 'feature/api-12-branch',
      INPUT_PR_JSON_FILE: prJsonFile,
    });

    expect(mockConstructLinearClient).not.toHaveBeenCalled();
    const outputs = readOutputs(outputFile);
    expect(outputs.has_linear_token).toBe('false');
    expect(outputs.ticket_count).toBe('0');
    expect(JSON.parse(outputs.candidate_ticket_ids_json)).toEqual(['API-12']);
    expect(JSON.parse(outputs.detected_ticket_ids_json)).toEqual([]);
    expect(JSON.parse(outputs.invalid_ticket_candidates_json)).toEqual([
      {
        id: 'API-12',
        prefix: 'API',
        extractionSources: ['branch', 'title'],
        reason: 'team_validation_unavailable',
      },
    ]);
  });

  it('continues without validated tickets when the Linear team list cannot be fetched', async () => {
    fs.writeFileSync(
      prJsonFile,
      JSON.stringify({ pr: { title: 'API-12', body: '' } }),
      'utf8',
    );
    const searchIssues = jest.fn();
    mockConstructLinearClient.mockImplementation(() => ({
      teams: jest.fn().mockRejectedValue(new Error('Linear unavailable')),
      searchIssues,
      issue: jest.fn(),
    }));

    await runGatherLinearContextAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_LINEAR_API_KEY: 'lin_api_test',
      INPUT_CURRENT_BRANCH: '',
      INPUT_PR_JSON_FILE: prJsonFile,
    });

    expect(searchIssues).not.toHaveBeenCalled();
    const outputs = readOutputs(outputFile);
    expect(outputs.has_linear_token).toBe('true');
    expect(outputs.team_list_fetched).toBe('false');
    expect(outputs.ticket_count).toBe('0');

    const context = readJsonFile(outputs.linear_context_file);
    expect(context).toMatchObject({
      teamListError: 'Linear unavailable',
      detectedTicketIds: [],
    });
    const summary = fs.readFileSync(outputs.linear_summary_file, 'utf8');
    expect(summary).toContain(
      'Linear team-prefix validation failed: Linear unavailable',
    );
  });
});
