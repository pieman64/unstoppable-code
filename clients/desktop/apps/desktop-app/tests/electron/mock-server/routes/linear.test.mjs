// In-process tests for the Linear GraphQL mock surface (WP-MOCK-LINEAR, Doc 9).
//
// Drives the REAL `@linear/sdk` `LinearClient` against a loopback server wired
// to `handleLinearRequest`, exercising viewer / teams / issueSearch / issue +
// the SDK's lazy nested resolvers (assignee/creator/state/team/project/cycle/
// labels). Also unit-tests the pure operation resolver and operation-name parser
// directly.
//
// Run:  node --test apps/desktop-app/tests/electron/mock-server/routes/linear.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LinearClient } from '@linear/sdk';
import {
  handleLinearRequest,
  parseOperationName,
  resolveLinearOperation,
  resolveLinearScenario,
} from './linear.mjs';
import { registerScenario, resetAll } from '../control-plane.mjs';

function startServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    void handleLinearRequest(request, response, url).then((handled) => {
      if (!handled) {
        response.writeHead(404).end('not handled');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

const SCENARIO = {
  linear: {
    viewer: { displayName: 'Test User', email: 'tester@example.com' },
    issues: [
      {
        id: 'iss_1',
        identifier: 'CAN-123',
        title: 'Fix the thing',
        description: 'Repro steps',
        state: { id: 'st1', name: 'In Progress', type: 'started' },
        assignee: {
          id: 'a1',
          displayName: 'Test User',
          email: 'tester@example.com',
        },
        creator: { id: 'c1', displayName: 'Creator', email: 'c@e.com' },
        team: { id: 't1', key: 'CAN', name: 'Canopy' },
        project: { id: 'p1', name: 'Q3 Roadmap' },
        cycle: { id: 'cy1', number: 5, name: 'Cycle 5' },
        labels: [
          { id: 'l1', name: 'bug' },
          { id: 'l2', name: 'p1' },
        ],
      },
      {
        id: 'iss_2',
        identifier: 'CAN-124',
        title: 'Add the feature',
        description: '',
      },
    ],
  },
};

test('parseOperationName reads the leading operation name', () => {
  assert.equal(parseOperationName('query viewer { id }'), 'viewer');
  assert.equal(
    parseOperationName('query searchIssues($term: String!) {}'),
    'searchIssues',
  );
  assert.equal(parseOperationName('query teams($first: Int) {}'), 'teams');
  assert.equal(parseOperationName('query issue($id: String!) {}'), 'issue');
  assert.equal(parseOperationName(undefined), undefined);
});

test('resolveLinearScenario uses the API key header, defaults when unregistered', () => {
  resetAll();
  registerScenario('lin_api_x', SCENARIO);
  const matched = resolveLinearScenario({
    headers: { authorization: 'lin_api_x' },
  });
  assert.equal(matched.viewer.email, 'tester@example.com');
  const fallback = resolveLinearScenario({ headers: {} });
  assert.ok(Array.isArray(fallback.issues));
});

test('resolveLinearOperation: viewer / searchIssues filter / invalid viewer', () => {
  const scenario = SCENARIO.linear;
  const viewer = resolveLinearOperation('viewer', {}, scenario);
  assert.equal(viewer.data.viewer.email, 'tester@example.com');

  const teams = resolveLinearOperation('teams', { first: 50 }, scenario);
  assert.deepEqual(
    teams.data.teams.nodes.map((team) => team.key),
    ['CAN'],
  );

  const search = resolveLinearOperation(
    'searchIssues',
    { term: 'feature' },
    scenario,
  );
  assert.equal(search.data.searchIssues.nodes.length, 1);
  assert.equal(search.data.searchIssues.nodes[0].identifier, 'CAN-124');

  const issue = resolveLinearOperation('issue', { id: 'iss_1' }, scenario);
  assert.equal(issue.data.issue.identifier, 'CAN-123');
  assert.deepEqual(issue.data.issue.assignee, { id: 'a1' });

  const invalid = resolveLinearOperation(
    'viewer',
    {},
    { viewer: false, issues: [] },
  );
  assert.ok(invalid.errors);

  const missing = resolveLinearOperation('issue', { id: 'nope' }, scenario);
  assert.ok(missing.errors);
});

test('real @linear/sdk: viewer + searchIssues + issue with nested resolvers', async () => {
  resetAll();
  const KEY = 'lin_api_sdk';
  registerScenario(KEY, SCENARIO);
  const { server, base } = await startServer();
  try {
    const client = new LinearClient({ apiKey: KEY, apiUrl: `${base}/graphql` });

    const viewer = await client.viewer;
    assert.equal(viewer.displayName, 'Test User');
    assert.equal(viewer.email, 'tester@example.com');

    const teams = await client.teams({ first: 50 });
    assert.deepEqual(
      teams.nodes.map((team) => team.key),
      ['CAN'],
    );

    const search = await client.searchIssues('feature');
    assert.deepEqual(
      search.nodes.map((n) => n.identifier),
      ['CAN-124'],
    );

    const issue = await client.issue('iss_1');
    assert.equal(issue.identifier, 'CAN-123');
    const [assignee, creator, state, team, project, cycle, labels] =
      await Promise.all([
        issue.assignee,
        issue.creator,
        issue.state,
        issue.team,
        issue.project,
        issue.cycle,
        issue.labels({ first: 50 }),
      ]);
    assert.equal(assignee.displayName, 'Test User');
    assert.equal(creator.displayName, 'Creator');
    assert.equal(state.name, 'In Progress');
    assert.equal(state.type, 'started');
    assert.equal(team.key, 'CAN');
    assert.equal(project.name, 'Q3 Roadmap');
    assert.equal(cycle.number, 5);
    assert.deepEqual(
      labels.nodes.map((l) => l.name),
      ['bug', 'p1'],
    );
  } finally {
    server.close();
  }
});

test('real @linear/sdk: invalid-key scenario rejects viewer', async () => {
  resetAll();
  registerScenario('bad', { linear: { viewer: false, issues: [] } });
  const { server, base } = await startServer();
  try {
    const client = new LinearClient({
      apiKey: 'bad',
      apiUrl: `${base}/graphql`,
    });
    await assert.rejects(() => client.viewer);
  } finally {
    server.close();
  }
});

test('non-/graphql or non-POST is not handled', async () => {
  const response = {
    writeHead() {
      return this;
    },
    end() {},
  };
  const handled = await handleLinearRequest(
    { method: 'GET', headers: {} },
    response,
    new URL('http://h/graphql'),
  );
  assert.equal(handled, false);
});

test('real SDK attachment lookup supplies bounded repository evidence', async () => {
  resetAll();
  registerScenario('attachments', {
    linear: {
      issues: [
        {
          id: 'issue-link',
          identifier: 'CAN-3606',
          title: 'Fix',
          attachments: [
            {
              id: 'attachment-link',
              url: 'https://github.com/acme/app/pull/7',
              sourceType: 'github',
              title: 'PR',
            },
          ],
        },
      ],
    },
  });
  const { server, base } = await startServer();
  try {
    const client = new LinearClient({
      apiKey: 'attachments',
      apiUrl: `${base}/graphql`,
    });
    const issue = await client.issue('issue-link');
    const attachments = await issue.attachments({ first: 50 });
    assert.equal(
      attachments.nodes[0].url,
      'https://github.com/acme/app/pull/7',
    );
    assert.equal(attachments.pageInfo.hasNextPage, false);
  } finally {
    server.close();
  }
});

test('real @linear/sdk: reference preview reads one exact issue', async () => {
  resetAll();
  const { server, base } = await startServer();
  registerScenario('lin_api_preview', {
    linear: {
      issues: [
        {
          id: 'iss_preview',
          identifier: 'CAN-42',
          title: 'Preview me',
          description: 'Body',
          url: 'https://linear.app/acme/issue/CAN-42/preview-me',
          state: { name: 'In Progress' },
          assignee: { name: 'Rowan' },
        },
      ],
    },
  });
  try {
    const client = new LinearClient({
      apiKey: 'lin_api_preview',
      apiUrl: `${base}/graphql`,
    });
    const query =
      'query referencePreviewIssue($id: String!) { issue(id: $id) { identifier } }';
    const { data } = await client.client.rawRequest(query, { id: 'CAN-42' });
    assert.equal(data.issue.title, 'Preview me');
    assert.deepEqual(data.issue.state, { name: 'In Progress' });
    assert.deepEqual(data.issue.assignee, {
      displayName: 'Rowan',
      name: 'Rowan',
    });
    assert.equal(data.issue.project, null);
    await assert.rejects(
      client.client.rawRequest(query, { id: 'CAN-43' }),
      /Entity not found/,
    );
  } finally {
    resetAll();
    server.close();
  }
});

test('real @linear/sdk: reference preview team catalog paginates', async () => {
  resetAll();
  const { server, base } = await startServer();
  registerScenario('lin_api_preview_teams', {
    linear: {
      previewTeams: [
        { id: 't1', key: 'CAN', name: 'Canopy' },
        { id: 't2', key: 'ECW', name: 'Ecom' },
        { id: 't3', key: 'REG', name: 'Registry' },
      ],
      teamPageSize: 2,
      issues: [],
    },
  });
  try {
    const client = new LinearClient({
      apiKey: 'lin_api_preview_teams',
      apiUrl: `${base}/graphql`,
    });
    const query =
      'query referencePreviewTeams($first: Int!, $after: String) { teams(first: $first, after: $after) { nodes { key } pageInfo { hasNextPage endCursor } } }';
    const first = await client.client.rawRequest(query, {
      first: 250,
      after: null,
    });
    assert.deepEqual(first.data.teams, {
      nodes: [{ key: 'CAN' }, { key: 'ECW' }],
      pageInfo: { hasNextPage: true, endCursor: '1' },
    });
    const second = await client.client.rawRequest(query, {
      first: 250,
      after: first.data.teams.pageInfo.endCursor,
    });
    assert.deepEqual(second.data.teams, {
      nodes: [{ key: 'REG' }],
      pageInfo: { hasNextPage: false, endCursor: '2' },
    });
  } finally {
    resetAll();
    server.close();
  }
});
