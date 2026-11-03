// Visual evidence companion: managed-delegation-parent.capture-spec.ts
// Run with: pnpm run test:electron:captures:built managed-delegation-parent.capture-spec.ts --reporter=line
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { createServer } from 'node:http';
import { expect as baseExpect, test } from '@playwright/test';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';

// Windows qualification runs x64 Electron and the provider binaries under ARM
// emulation, where Codex-parent turns and main-to-renderer updates take
// several times longer than on macOS. Scale every wait there; passing cases
// still finish as soon as their condition holds.
const hostPlatform = hostOperatingSystem();
const TIMEOUT_SCALE = hostPlatform === 'win32' ? 3 : 1;
const scaled = (ms) => ms * TIMEOUT_SCALE;
const expect = baseExpect.configure({ timeout: scaled(15_000) });
import { openBackgroundDrawer } from './backgroundDrawer.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  readChatStorageIndexes,
  readChatStorageMessages,
} from './readChatStorage.mjs';
import { selectModelOption } from './model-selection-fixture.mjs';
import { seedCodexFixtureModelCatalog } from './seeders/seedCodexFixtureModelCatalog.mjs';
import {
  seedDemoWorkspaces,
  cleanupDemoWorkspaces,
} from './demoWorkspaces.mjs';
import {
  seedWorktreeChat,
  seedWorkspaceApprovals,
  seedAgentModels,
  seedMcpServers,
} from './seeders/index.mjs';
import {
  launchCanopy,
  closeCanopy,
  reapSupervisedProcessTree,
  removeTestDataDir,
} from './launchCanopy.mjs';
import {
  isFileBroker as isFileBrokerProcess,
  parsePosixProcessTable,
  selectNativeDescendants,
  windowsImageName,
} from './native-delegation-processes.mjs';
import {
  TOOL_NAMESPACE,
  claudeToolName,
  codexToolName,
  createDelegationInference,
  delegationAgentSkillPath,
} from './delegationRuntime.mjs';
import { chooseSettingsOption } from './helpers/settingsSelect.mjs';

const PALETTE_SHORTCUT = hostPlatform === 'darwin' ? 'Meta+K' : 'Control+K';

// Delegated Codex workers run without an OS sandbox on Windows, so the Codex
// fixtures' POSIX commands and sandbox-enforced denials do not apply there.
// Until phase 10 ports those fixtures, skip cases that spawn a delegated Codex
// child or grandchild on Windows. Nested grandchildren use the root parent's
// harness (see delegationRuntime.mjs), so a Codex parent with a nested action
// spawns a Codex grandchild.
const delegatedCodexUnavailable = hostPlatform === 'win32';
function spawnsDelegatedCodex({ parent, child, action }) {
  return (
    child === 'codex' ||
    (parent === 'codex' && Boolean(action?.startsWith('nested')))
  );
}

// Mirrors getSkillSourceDirectoryName in
// packages/desktop-shared/src/node/skills/paths.ts: Windows escapes the
// characters its file names reserve, such as the colon in `custom:app`.
function skillSourceDirectoryName(sourceId) {
  if (hostPlatform !== 'win32') return sourceId;
  const hex = (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
  return Array.from(sourceId, (character) =>
    character.charCodeAt(0) < 32 || '%<>:"/\\|?*'.includes(character)
      ? hex(character)
      : character,
  )
    .join('')
    .replace(/[. ]+$/, (value) => Array.from(value, hex).join(''));
}
const delegatedReviewSkillDirectory = (userDataDir) =>
  path.join(
    userDataDir,
    'skills',
    skillSourceDirectoryName('custom:app'),
    'delegated-review',
  );

const workspaceId = 'demo-ts-pnpm-vite';
const worktreeId = 'demo-main';
// The app-owned `managed-delegate` tools a Claude child may receive beside its
// native tools; the code graph tools appear only when the worktree has a graph,
// and Search/Load Deferred Tools while the root chat allows deferred tools
// (the default).
const delegateAppToolName =
  /^mcp__canopy__(?:GetScriptOutput|GetGitPreferences|SaveMemory|SearchMemory|ReadMemory|ReadPipelineYaml|GetFileComments|SearchActions|DispatchAction|SearchWatchers|SetupWatchers|WatchGitHubItems|GetGitHubPullRequestStatus|WatchCommand|ScheduleWakeup|DeleteWatchers|GetCodeGraphContext|BuildOrUpdateCodeGraph|QueryCodeGraph|SearchCodeGraph|ExplainCodeSymbol|GetImpactRadius|DetectChangedSymbols|CompareChangeImpact|GetReviewContext|SearchDeferredTools|LoadDeferredTools)$/;
const configuredAgentId = 'agent_model_delegated_reviewer';
const agentMcpServerId = 'delegated-review';
const ambientMcpServerId = 'ambient-only';
const agentPluginMarketplaceId = 'delegation-local';
const agentPluginName = 'delegated-review-plugin';
const selectedMcpManagedName = `appproxy-delegated-review-tool--${createHash(
  'sha256',
)
  .update(
    JSON.stringify([
      'managed-mcp-server-name-v1',
      'proxy',
      agentMcpServerId,
      'default',
    ]),
  )
  .digest('hex')
  .slice(0, 16)}`;

async function startAgentCapabilityMcpFixture(caseId) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const message = raw ? JSON.parse(raw) : null;
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    if (!message || !('id' in message)) {
      response.writeHead(204).end();
      return;
    }
    const selected = request.url === '/agent';
    const name = selected ? 'review_evidence' : 'ambient_probe';
    let result;
    if (message.method === 'initialize')
      result = {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: {
          name: selected ? agentMcpServerId : ambientMcpServerId,
          version: '1.0.0',
        },
      };
    else if (message.method === 'tools/list')
      result = {
        tools: [name, ...(selected ? ['denied_probe'] : [])].map(
          (toolName) => ({
            name: toolName,
            description:
              toolName === 'denied_probe'
                ? 'This selected tool is denied by the parent policy.'
                : selected
                  ? 'Return independent review evidence.'
                  : 'Parent-only ambient probe.',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          }),
        ),
      };
    else if (message.method === 'tools/call') {
      calls.push({ path: request.url, ...message.params });
      result = {
        content: [
          {
            type: 'text',
            text: selected
              ? `MCP_REVIEW_EVIDENCE_${caseId}`
              : `AMBIENT_ONLY_${caseId}`,
          },
        ],
      };
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Unknown method ${message.method}` },
        }),
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    calls,
    origin,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function seedAgentCapabilityMcpServers(userDataDir, origin) {
  const now = '2026-09-08T00:00:00.000Z';
  seedMcpServers({
    userDataDir,
    servers: [
      [agentMcpServerId, 'Delegated Review Tools', '/agent'],
      [ambientMcpServerId, 'Ambient Parent Tools', '/ambient'],
    ].map(([id, name, route]) => ({
      definition: {
        id,
        name,
        description: name,
        type: 'http',
        url: `${origin}${route}`,
        createdAt: now,
        updatedAt: now,
      },
      configs: [
        {
          id: 'default',
          name: 'Default',
          description: '',
          enabled: true,
          envVars: {},
          extraArgs: [],
          extraHeaders: {},
          createdAt: now,
          updatedAt: now,
        },
      ],
    })),
  });
}

/**
 * What a failed agent-capabilities run leaves behind about the plugin's MCP
 * server: the server's own log (it appends `STARTED` when a provider spawns
 * it) and the capability files materialized for a Codex child, with the
 * contents of the small ones that configure it.
 */
function agentPluginCapabilityState(userDataDir, pluginLog) {
  const files = [];
  const contents = {};
  const walk = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const relative = path.relative(userDataDir, full);
      files.push(relative);
      if (['.mcp.json', 'config.toml', 'plugin.json'].includes(entry.name))
        contents[relative] = readFileSync(full, 'utf8').slice(0, 4_000);
    }
  };
  walk(path.join(userDataDir, 'codex-capabilities'));
  return {
    pluginMcpLog: existsSync(pluginLog)
      ? readFileSync(pluginLog, 'utf8')
      : null,
    codexCapabilityFiles: files.sort(),
    codexCapabilityConfig: contents,
  };
}

function seedAgentCapabilityPlugin(userDataDir, caseId) {
  const now = '2026-09-08T00:00:00.000Z';
  const directory = path.join(userDataDir, 'plugin-fixtures', agentPluginName);
  const script = path.join(directory, 'mcp', 'plugin-review.cjs');
  const log = path.join(directory, 'plugin-mcp-calls.log');
  mkdirSync(path.dirname(script), { recursive: true });
  mkdirSync(path.join(directory, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(directory, '.codex-plugin'), { recursive: true });
  mkdirSync(path.join(directory, 'skills', 'plugin-review'), {
    recursive: true,
  });
  writeFileSync(
    script,
    `
const { appendFileSync } = require('node:fs');
const log = ${JSON.stringify(log)};
appendFileSync(log, 'STARTED\\n');
appendFileSync(log, 'ENV_PROBE=' + (process.env.UNRELATED_MANAGED_SECRET ?? 'absent') + '\\n');
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) continue;
    let result;
    if (message.method === 'initialize') result = {
      protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'plugin-review-fixture', version: '1.0.0' },
    };
    else if (message.method === 'tools/list') result = {
      tools: [{ name: 'plugin_review', description: 'Review through the selected plugin.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    };
    else if (message.method === 'tools/call') {
      appendFileSync(log, JSON.stringify(message.params) + '\\n');
      result = { content: [{ type: 'text', text: 'PLUGIN_REVIEW_EVIDENCE_${caseId}' }] };
    }
    if (result) send({ jsonrpc: '2.0', id: message.id, result });
    else send({ jsonrpc: '2.0', id: message.id,
      error: { code: -32601, message: 'Unknown method ' + message.method } });
  }
});
`,
    'utf8',
  );
  writeFileSync(
    path.join(directory, '.mcp.json'),
    `${JSON.stringify({
      mcpServers: {
        review: {
          command: process.execPath,
          args: ['${CLAUDE_PLUGIN_ROOT}/mcp/plugin-review.cjs'],
        },
      },
    })}\n`,
  );
  writeFileSync(
    path.join(directory, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({
      name: agentPluginName,
      version: '1.0.0',
      mcpServers: './.mcp.json',
    })}\n`,
  );
  writeFileSync(
    path.join(directory, '.codex-plugin', 'plugin.json'),
    `${JSON.stringify({
      name: agentPluginName,
      version: '1.0.0',
      mcpServers: './.mcp.json',
    })}\n`,
  );
  writeFileSync(
    path.join(directory, 'skills', 'plugin-review', 'SKILL.md'),
    `---\nname: plugin-review\ndescription: Verify the selected plugin's independent review.\n---\n\nPLUGIN_SKILL_EVIDENCE_${caseId}\n`,
  );
  const facet = (provider) => ({
    provider,
    mode: 'native',
    name: agentPluginName,
    installLocation: directory,
    sourcePath: directory,
  });
  writeFileSync(
    path.join(userDataDir, 'plugins-cache.json'),
    `${JSON.stringify({
      version: 2,
      lastRefreshed: now,
      lastProviderRefreshAt: now,
      marketplaces: [
        {
          id: agentPluginMarketplaceId,
          name: 'Delegation Local Marketplace',
          description: 'Deterministic Agent capability fixture',
          sourceType: 'local',
          sourceUrl: '',
          installLocation: directory,
          lastUpdated: now,
          pluginCount: 1,
          validProviders: ['claude', 'codex'],
          providerStatus: Object.fromEntries(
            ['claude', 'codex'].map((provider) => [
              provider,
              {
                provider,
                state: 'valid',
                accepted: true,
                pluginCount: 1,
                lastCheckedAt: now,
              },
            ]),
          ),
          plugins: [
            {
              name: agentPluginName,
              description: 'Plugin skill and local MCP review',
              sourcePath: directory,
              marketplaceId: agentPluginMarketplaceId,
              providerSupport: { claude: 'native', codex: 'native' },
              facets: { claude: facet('claude'), codex: facet('codex') },
              details: {
                skills: [
                  {
                    name: 'plugin-review',
                    description: 'Plugin review skill',
                    filePath: 'skills/plugin-review/SKILL.md',
                  },
                ],
                agents: [],
                commands: [],
                apps: [],
                hooks: [],
                lspServers: [],
                hasReadme: false,
                mcpServers: [
                  {
                    name: 'review',
                    type: 'command',
                    command: process.execPath,
                    args: ['${CLAUDE_PLUGIN_ROOT}/mcp/plugin-review.cjs'],
                  },
                ],
              },
            },
          ],
        },
      ],
    })}\n`,
  );
  return log;
}

/**
 * Configured Agents inherit the root chat's capabilities too, so the parent's
 * ambient MCP server reaches the child as an inherited item. A Claude child
 * lists its MCP tools up front; a Codex child finds them through tool search,
 * so only the grant records the inherited server there.
 */
function expectInheritedAmbientMcp(run, child, fixture) {
  expect(run?.capabilityGrant?.summary?.items).toContainEqual({
    kind: 'mcp',
    name: 'Ambient Parent Tools / Default',
    source: 'inherited',
  });
  if (child === 'claude')
    expect(
      fixture.requests.some(
        (request) => request.role === 'child' && request.hasAmbientMcpTool,
      ),
    ).toBe(true);
}

function retainedRuns(userDataDir) {
  const directory = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'worktree-data',
    worktreeId,
    'delegation',
    'runs',
  );
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) =>
      JSON.parse(readFileSync(path.join(directory, name), 'utf8')),
    );
}

function retainedCodexRollouts(userDataDir) {
  const directory = path.join(
    userDataDir,
    'provider-state',
    'codex',
    'sessions',
  );
  if (!existsSync(directory)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.endsWith('.jsonl')) files.push(target);
    }
  };
  visit(directory);
  return files;
}

function retainedTimers(userDataDir) {
  try {
    const workspaceRoot = path.join(userDataDir, 'workspaces', workspaceId);
    // A migrated scope has a manifest; before that the chat is in the legacy file.
    if (
      existsSync(
        path.join(
          workspaceRoot,
          'chat-storage-manifests',
          `${worktreeId}.json`,
        ),
      )
    )
      return readChatStorageMessages(
        workspaceRoot,
        worktreeId,
        'delegating-parent',
      ).flatMap((message) =>
        message.blocks
          .filter((block) => block.type === 'turn_timer')
          .map((block) => ({ id: message.id, ...block })),
      );
    const file = JSON.parse(
      readFileSync(
        path.join(
          userDataDir,
          'workspaces',
          workspaceId,
          'chats',
          `${worktreeId}.json`,
        ),
        'utf8',
      ),
    );
    return (
      file.tabs
        .find((tab) => tab.id === 'delegating-parent')
        ?.messages.flatMap((message) =>
          message.blocks
            .filter((block) => block.type === 'turn_timer')
            .map((block) => ({ id: message.id, ...block })),
        ) ?? []
    );
  } catch {
    return [];
  }
}

/**
 * Owners of the open pauses on the parent chat's current turn, read from the
 * canonical turn state in the durable chat index. Main writes a persisted
 * timer block's `pauseOwnerIds` only from turn-end effects, so pause
 * ownership during a turn is asserted here instead. Undefined until the
 * scope has migrated to chat storage.
 */
function openPauseOwnerIds(userDataDir) {
  const pauses = parentTurnState(userDataDir)?.current?.pauses;
  return pauses
    ?.filter((pause) => pause.endedAtMs == null)
    .map((pause) => pause.ownerId);
}

/** The parent chat's last settled canonical turn record. */
function endedTurnRecord(userDataDir) {
  return parentTurnState(userDataDir)?.lastEnded;
}

/**
 * The parent chat's canonical turn state from the durable chat index, or
 * undefined until the scope has migrated to chat storage.
 */
function parentTurnState(userDataDir) {
  const workspaceRoot = path.join(userDataDir, 'workspaces', workspaceId);
  if (
    !existsSync(
      path.join(workspaceRoot, 'chat-storage-manifests', `${worktreeId}.json`),
    )
  )
    return undefined;
  return (
    readChatStorageIndexes(workspaceRoot, worktreeId).live.runtimeByChatId[
      'delegating-parent'
    ]?.turn ?? { current: undefined, lastEnded: undefined }
  );
}

function retainedMetrics(userDataDir) {
  const directory = path.join(
    userDataDir,
    'agent-observability',
    'diagnostics',
    'session-events',
  );
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) =>
      readFileSync(path.join(directory, name), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    )
    .filter((event) => event.kind === 'managed_delegation')
    .map((event) => event.delegationMetric);
}

function listWindowsProcesses() {
  const stdout = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  ).trim();
  const parsed = stdout ? JSON.parse(stdout) : [];
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    pid: Number(row.ProcessId),
    parent: Number(row.ParentProcessId),
    // Sandbox-owned processes can hide their executable path.
    command: row.ExecutablePath || row.Name || '',
  }));
}
function isFileBroker(entry) {
  return isFileBrokerProcess(entry, hostPlatform);
}
function nativeDescendants(rootPid) {
  const rows =
    hostPlatform === 'win32'
      ? listWindowsProcesses()
      : parsePosixProcessTable(
          execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], {
            encoding: 'utf8',
          }),
        );
  // Linux `ps comm` is truncated and has no directory, so the helper resolves
  // owned descendants to their absolute /proc/<pid>/exe.
  return selectNativeDescendants({
    rows,
    rootPid,
    platform: hostPlatform,
  });
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    // The process exists but belongs to another account, such as a Windows
    // sandbox user.
    if (error.code === 'EPERM') return true;
    throw error;
  }
}
// Windows reuses PIDs quickly, so a match must also keep its image name.
function runningNativeProcesses(entries) {
  if (hostPlatform !== 'win32')
    return entries.filter((entry) => alive(entry.pid));
  const current = listWindowsProcesses();
  return entries.filter((entry) =>
    current.some(
      (row) =>
        row.pid === entry.pid &&
        windowsImageName(row.command) === windowsImageName(entry.command),
    ),
  );
}
async function revealDelegatedAgent(surface) {
  const delegated = surface.getByTestId('chat-delegated-agent');
  const expand = delegated.getByRole('button', {
    name: 'Expand delegated task',
  });
  const collapsedTurns = surface.locator(
    'button[aria-label^="Agent steps"][aria-expanded="false"]',
  );
  await expect
    .poll(
      async () =>
        (await expand.isVisible().catch(() => false)) ||
        (await collapsedTurns.count()) > 0,
      { timeout: scaled(15_000) },
    )
    .toBe(true);
  if (!(await expand.isVisible().catch(() => false)))
    await expandCollapsedTurns(surface);
  await expect(delegated).toHaveCount(1);
  await expect(expand).toBeVisible();
  return delegated;
}
// Expands every completed turn whose steps collapsed behind an "Agent steps"
// summary. An expanded summary leaves the `aria-expanded="false"` match, so
// each pass re-queries the first collapsed one and waits for the match to
// shrink; indexes from an earlier `.all()` snapshot go stale after one click.
async function expandCollapsedTurns(surface) {
  const collapsedTurns = surface.locator(
    'button[aria-label^="Agent steps"][aria-expanded="false"]',
  );
  for (let pass = 0; pass < 20; pass += 1) {
    const remaining = await collapsedTurns.count();
    if (remaining === 0) return;
    await collapsedTurns.first().click();
    await expect
      .poll(() => collapsedTurns.count(), { timeout: scaled(5_000) })
      .toBeLessThan(remaining);
  }
  await expect(collapsedTurns).toHaveCount(0);
}
function delegatedCard(surface, delegationId) {
  return surface.locator(
    `[data-testid="chat-delegated-agent"][data-delegation-id="${delegationId}"]`,
  );
}
// A background delegate's row in the composer's background drawer, which
// lists the chat's live background delegates (background drawer D2). Opens
// the drawer first.
async function drawerDelegateRow(surface, delegationId) {
  const tray = await openBackgroundDrawer(surface, {
    timeout: scaled(30_000),
  });
  return delegationId === undefined
    ? tray.getByTestId('background-tray-agent').first()
    : tray.locator(`[data-tray-row="agent:managed:${delegationId}"]`);
}
// The first delegated-task Stop in the chat, expanding completed turns whose
// steps collapsed behind their "Agent steps" summary.
async function revealDelegatedStop(surface) {
  const stop = surface.getByTestId('delegated-agent-stop').first();
  await expect
    .poll(async () => {
      await expandCollapsedTurns(surface);
      return stop.isVisible();
    })
    .toBe(true);
  return stop;
}
// The composer's Stop ends only the root turn. Nothing may cancel the chat's
// delegations afterwards, so allow a wrong cancellation time to land before
// reading the retained runs back.
async function runsAfterParentStop(userDataDir) {
  await new Promise((resolve) => setTimeout(resolve, scaled(2_000)));
  return retainedRuns(userDataDir);
}
const cases = ['claude', 'codex'].flatMap((parent) =>
  ['claude', 'codex'].flatMap((child) =>
    ['foreground', 'background'].map((mode) => ({ parent, child, mode })),
  ),
);
for (const parent of ['claude', 'codex'])
  cases.push({
    parent,
    child: 'claude',
    mode: 'background',
    action: 'continuation-approval',
  });
cases.push({
  parent: 'claude',
  child: 'codex',
  mode: 'foreground',
  action: 'grant-deny',
});
for (const child of ['claude', 'codex'])
  for (const mode of ['foreground', 'background'])
    cases.push({ parent: 'claude', child, mode, action: 'command-approval' });
cases.push({
  parent: 'claude',
  child: 'codex',
  mode: 'foreground',
  action: 'command-native-rules',
});
cases.push({
  parent: 'claude',
  child: 'codex',
  mode: 'foreground',
  action: 'fast',
});
cases.push({
  parent: 'codex',
  child: 'codex',
  mode: 'foreground',
  action: 'fast',
});
cases.push({
  parent: 'claude',
  child: 'claude',
  mode: 'background',
  autoArchive: true,
});
for (const policy of [
  'native-read',
  'native-search',
  'native-child',
  'managed-child',
])
  cases.push({ parent: 'codex', child: 'claude', mode: 'foreground', policy });
for (const policy of [
  'native-exec',
  'skill-read',
  'native-git-write',
  'native-file-write',
  'native-nested-git',
  'question',
  'native-child',
  'managed-child',
])
  cases.push({ parent: 'codex', child: 'codex', mode: 'foreground', policy });
for (const parent of ['claude', 'codex'])
  for (const child of ['claude', 'codex'])
    for (const action of ['write', 'resume', 'write-approval', 'isolation'])
      cases.push({ parent, child, mode: 'background', action });
// A Codex child appends to its granted file straight from the shell: the
// write grant reaches the Codex sandbox, with no request_permissions turn
// grant first.
cases.push({
  parent: 'claude',
  child: 'codex',
  mode: 'background',
  action: 'shell-append',
});
// Delegates edit files of any size: a shared-worktree edit lands in place,
// and an isolated edit applies to the parent from the delegate's worktree.
cases.push({
  parent: 'codex',
  child: 'claude',
  mode: 'background',
  action: 'write',
  largeEvidence: true,
});
cases.push({
  parent: 'claude',
  child: 'claude',
  mode: 'background',
  action: 'isolation',
  largeEvidence: true,
});
// A failed isolated apply changes nothing; the delegate reconciles and a
// second apply succeeds.
cases.push({
  parent: 'claude',
  child: 'claude',
  mode: 'background',
  action: 'isolation-conflict',
});
for (const parent of ['claude', 'codex'])
  cases.push({
    parent,
    child: 'codex',
    mode: 'background',
    action: 'resume-native-write',
  });
for (const child of ['claude', 'codex']) {
  for (const action of ['git-history', 'git-history-isolated'])
    cases.push({
      parent: child === 'claude' ? 'codex' : 'claude',
      child,
      mode: 'foreground',
      action,
    });
  cases.push({
    parent: child === 'claude' ? 'codex' : 'claude',
    child,
    mode: 'foreground',
    action: 'agent',
  });
  cases.push({
    parent: child === 'claude' ? 'codex' : 'claude',
    child,
    mode: 'foreground',
    action: 'agent-follow-up',
  });
  cases.push({
    parent: child === 'claude' ? 'codex' : 'claude',
    child,
    mode: 'foreground',
    action: 'agent-capabilities',
  });
  for (const action of [
    'watch',
    'stop',
    'quit',
    'long-running',
    'policy-change',
  ])
    cases.push({
      parent: child === 'claude' ? 'codex' : 'claude',
      child,
      mode: 'background',
      action,
    });
  for (const mode of ['foreground', 'background'])
    cases.push({
      parent: child === 'claude' ? 'codex' : 'claude',
      child,
      mode,
      action: 'cancel',
    });
  cases.push({
    parent: child === 'claude' ? 'codex' : 'claude',
    child,
    mode: 'foreground',
    action: 'partial-failure',
  });
}
for (const child of ['claude', 'codex'])
  cases.push({
    parent: child === 'claude' ? 'codex' : 'claude',
    child,
    mode: 'background',
    action: 'account-refresh',
  });
cases.push({
  parent: 'codex',
  child: 'claude',
  mode: 'background',
  action: 'capacity',
});
cases.push({
  parent: 'claude',
  child: 'codex',
  mode: 'background',
  action: 'restraint',
});
cases.push({
  parent: 'codex',
  child: 'claude',
  mode: 'background',
  action: 'model-change',
});
cases.push({
  parent: 'codex',
  child: 'claude',
  mode: 'background',
  action: 'initialization-cancel',
});
cases.push({
  parent: 'claude',
  child: 'codex',
  mode: 'background',
  action: 'initialization-cancel',
});
for (const parent of ['claude', 'codex']) {
  for (const action of [
    'async',
    'discovery',
    'proactive',
    'setting-off',
    'session-reuse',
  ])
    cases.push({
      parent,
      child: parent === 'claude' ? 'codex' : 'claude',
      mode: action === 'setting-off' ? 'background' : 'foreground',
      action,
    });
}
cases.push({
  parent: 'claude',
  child: 'codex',
  mode: 'background',
  action: 'capacity',
});
cases.push({
  parent: 'claude',
  child: 'codex',
  mode: 'background',
  action: 'capacity-custom',
});
// Children load the parent's project instructions and receive app tools.
for (const parent of ['claude', 'codex'])
  cases.push({
    parent,
    child: parent === 'claude' ? 'codex' : 'claude',
    mode: 'foreground',
    action: 'project-context',
  });
// A delegate's command watch notifies that delegate, never the root chat.
for (const parent of ['claude', 'codex'])
  cases.push({
    parent,
    child: parent === 'claude' ? 'codex' : 'claude',
    mode: 'foreground',
    action: 'delegate-watch',
  });
// A Claude child's shell detachment is refused with guidance, while its
// CLI-managed background task runs and its output file is readable.
cases.push({
  parent: 'codex',
  child: 'claude',
  mode: 'background',
  action: 'background-task',
});

for (const parent of ['claude', 'codex'])
  for (const child of ['claude', 'codex'])
    cases.push({ parent, child, mode: 'background', action: 'nested' });

cases.push(
  {
    parent: 'codex',
    child: 'codex',
    mode: 'background',
    action: 'nested-depth-lowered',
  },
  {
    parent: 'codex',
    child: 'claude',
    mode: 'background',
    action: 'nested-resume',
  },
  {
    parent: 'codex',
    child: 'claude',
    mode: 'background',
    action: 'nested-grant-attenuation',
  },
  {
    parent: 'codex',
    child: 'codex',
    mode: 'background',
    action: 'nested-follow-up',
  },
  {
    parent: 'claude',
    child: 'codex',
    mode: 'background',
    action: 'nested-approval',
  },
  {
    parent: 'codex',
    child: 'claude',
    mode: 'background',
    action: 'nested-approval',
  },
  {
    parent: 'codex',
    child: 'claude',
    mode: 'background',
    action: 'nested-cancel',
  },
);

for (const {
  parent,
  child,
  mode,
  autoArchive,
  policy,
  action,
  largeEvidence,
} of cases) {
  test(`${parent} to ${child} ${mode}${autoArchive ? ' auto archive' : ''}${policy ? ` ${policy} denial` : ''}${action ? ` ${action}` : ''}${largeEvidence ? ' large file' : ''}: real confined child and durable result`, async ({}, testInfo) => {
    test.skip(
      delegatedCodexUnavailable &&
        spawnsDelegatedCodex({ parent, child, action }),
      'Delegated Codex fixtures are not yet ported to Windows (phase 10)',
    );
    // Windows: a Codex parent's pending apply_patch approval leaves its turn
    // timer completed instead of paused. This is the parent chat's approval
    // timing, not delegation; phase 10 investigates it.
    test.fixme(
      hostPlatform === 'win32' &&
        parent === 'codex' &&
        action === 'continuation-approval',
      'Codex parent turn timer does not pause for a pending patch approval on Windows (phase 10)',
    );
    test.setTimeout(scaled(240_000));
    const caseId = `${parent}-${child}-${mode}${policy ? `-${policy}` : ''}${action ? `-${action}` : ''}`;
    let retainedSkillRemoved = false;
    let lateGitSibling;
    let lateGitSiblingCreated = false;
    const fixture = await createDelegationInference({
      parent,
      child,
      mode,
      caseId,
      policy,
      action,
      onRequest: (requests) => {
        if (
          child === 'codex' &&
          action?.startsWith('git-history') &&
          lateGitSibling &&
          !lateGitSiblingCreated &&
          requests.some((request) => request.role === 'child')
        ) {
          lateGitSiblingCreated = true;
          execFileSync(
            'git',
            ['worktree', 'add', '--detach', lateGitSibling.path],
            { cwd: lateGitSibling.cwd },
          );
          execFileSync(
            'git',
            [
              'config',
              '--worktree',
              'delegation.lateSiblingFixture',
              'SIBLING_PRIVATE_CONFIG',
            ],
            { cwd: lateGitSibling.path },
          );
        }
        if (
          ['agent', 'agent-capabilities', 'agent-follow-up'].includes(action) &&
          !retainedSkillRemoved &&
          requests.some((request) => request.role === 'child')
        ) {
          rmSync(delegatedReviewSkillDirectory(userDataDir), {
            recursive: true,
          });
          retainedSkillRemoved = true;
        }
        writeFileSync(
          testInfo.outputPath('inference-requests.json'),
          JSON.stringify(requests, null, 2),
        );
      },
    });
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'managed-delegation-'),
    );
    const agentMcp = ['agent-capabilities', 'agent-follow-up'].includes(action)
      ? await startAgentCapabilityMcpFixture(caseId)
      : null;
    const agentPluginLog =
      action === 'agent-capabilities'
        ? seedAgentCapabilityPlugin(userDataDir, caseId)
        : null;
    if (agentMcp) seedAgentCapabilityMcpServers(userDataDir, agentMcp.origin);
    const demo = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      // Exercise both sides of Git metadata resolution: the shared-history
      // case uses the repository's primary checkout, while the isolated case
      // selects a linked worktree.
      createWorktrees: action !== 'git-history',
    });
    if (action === 'git-history') {
      const workspace = demo.workspaces[0];
      const primaryCheckout = path.join(
        userDataDir,
        'workspaces',
        workspace.id,
        'worktrees',
        'demo-main',
      );
      mkdirSync(path.dirname(primaryCheckout), { recursive: true });
      execFileSync(
        'git',
        ['clone', '--no-hardlinks', workspace.repoPath, primaryCheckout],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      execFileSync('git', ['checkout', '-b', 'demo-main'], {
        cwd: primaryCheckout,
      });
      writeFileSync(
        path.join(userDataDir, 'workspaces', workspace.id, 'worktrees.json'),
        JSON.stringify({
          version: 1,
          worktrees: [
            {
              id: 'demo-main',
              branchName: 'demo-main',
              createdAt: '2026-09-18T00:00:00.000Z',
              trackedBaseBranch: 'main',
            },
          ],
        }),
      );
      workspace.worktreePath = primaryCheckout;
    }
    writeFileSync(
      path.join(demo.workspaces[0].worktreePath, 'delegation-evidence.txt'),
      `// ${fixture.canary}\nexport async function loadSource(read) { try { return await read(); } catch { throw new Error('Source unavailable'); } }\n${
        // Over the 64 KiB per-file limit delegated edits once had.
        largeEvidence ? `// ${'padding '.repeat(12)}\n`.repeat(800) : ''
      }`,
    );
    writeFileSync(
      path.join(demo.workspaces[0].worktreePath, '.env'),
      fixture.privateCanary,
    );
    if (policy === 'native-search')
      writeFileSync(
        path.join(demo.workspaces[0].worktreePath, 'credentials'),
        fixture.privateCanary,
      );
    if (policy === 'native-nested-git') {
      mkdirSync(path.join(demo.workspaces[0].worktreePath, 'nested/.git'), {
        recursive: true,
      });
      writeFileSync(
        path.join(demo.workspaces[0].worktreePath, 'nested/.git/private'),
        fixture.privateCanary,
      );
    }
    writeFileSync(
      path.join(demo.workspaces[0].worktreePath, 'delegation-follow-up.txt'),
      `RESUMED_${fixture.canary}`,
    );
    if (action === 'project-context')
      for (const file of ['CLAUDE.md', 'AGENTS.md'])
        writeFileSync(
          path.join(demo.workspaces[0].worktreePath, file),
          `# Project instructions\n\nPROJECT_INSTRUCTIONS_${caseId}\n`,
        );
    if (
      action === 'isolation' ||
      action === 'isolation-conflict' ||
      action === 'nested-resume' ||
      action?.startsWith('git-history')
    ) {
      const cwd = demo.workspaces[0].worktreePath;
      execFileSync('git', ['add', 'delegation-evidence.txt'], { cwd });
      execFileSync(
        'git',
        [
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-m',
          action?.startsWith('git-history')
            ? fixture.canary
            : 'Seed isolated evidence',
        ],
        { cwd },
      );
      if (action?.startsWith('git-history')) {
        execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], {
          cwd,
        });
        execFileSync(
          'git',
          ['config', 'delegation.fixture', 'READ_ONLY_GIT_CONFIG'],
          { cwd },
        );
        execFileSync(
          'git',
          [
            'config',
            '--worktree',
            'delegation.worktreeFixture',
            'READ_ONLY_WORKTREE_CONFIG',
          ],
          { cwd },
        );
        const siblingWorktree = path.join(userDataDir, 'git-sibling-worktree');
        execFileSync('git', ['worktree', 'add', '--detach', siblingWorktree], {
          cwd,
        });
        execFileSync(
          'git',
          [
            'config',
            '--worktree',
            'delegation.siblingFixture',
            'SIBLING_PRIVATE_CONFIG',
          ],
          { cwd: siblingWorktree },
        );
        lateGitSibling = {
          cwd,
          path: path.join(userDataDir, 'git-late-sibling-worktree'),
        };
      }
      writeFileSync(
        path.join(cwd, 'parent-only.txt'),
        'Parent dirty changes must survive.',
      );
      // An uncommitted parent edit the isolated delegate never sees.
      if (action === 'isolation-conflict')
        writeFileSync(
          path.join(cwd, 'delegation-evidence.txt'),
          `${readFileSync(path.join(cwd, 'delegation-evidence.txt'), 'utf8')}// Parent edit\n`,
        );
    }
    if (action === 'command-native-rules') {
      // Keep the project file too: even a disabled/untrusted layer must not
      // prevent launch. The isolated native user layer proves rule execution.
      // Codex-child only (skipped on Windows): phase 10 must match the
      // PowerShell command delegationRuntime.mjs sends there.
      for (const rules of [
        path.join(demo.workspaces[0].worktreePath, '.codex/rules'),
        path.join(userDataDir, 'provider-state/codex/rules'),
      ]) {
        mkdirSync(rules, { recursive: true });
        writeFileSync(
          path.join(rules, 'allow.rules'),
          'prefix_rule(pattern=["cat"], decision="allow")\nprefix_rule(pattern=["/bin/echo", "DENIED_COMMAND_CANARY"], decision="forbidden")\n',
        );
      }
    }
    const initialHeadRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: demo.workspaces[0].worktreePath,
      encoding: 'utf8',
    }).trim();
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId,
      defaultMode:
        action === 'grant-deny'
          ? 'auto'
          : [
                'write-approval',
                'command-approval',
                'command-native-rules',
                'continuation-approval',
                'nested-approval',
                'nested-cancel',
              ].includes(action)
            ? 'ask'
            : 'full-access',
      ...([
        'write-approval',
        'grant-deny',
        'command-approval',
        'command-native-rules',
        'continuation-approval',
        'nested-approval',
        'nested-cancel',
      ].includes(action)
        ? {
            rules: [
              { kind: 'mcp', server: TOOL_NAMESPACE, tool: 'DelegateTask' },
              { kind: 'tool', toolName: codexToolName('spawn_delegate') },
              { kind: 'tool', toolName: 'Read' },
              // Keep the file-grant scenarios focused on their scope prompt.
              ...(['write-approval', 'grant-deny'].includes(action)
                ? [{ kind: 'command', pattern: '*' }]
                : []),
            ]
              .map((target, index) => ({
                id: `parent-rule-${index}`,
                behavior: 'allow',
                target,
                origin: 'settings',
                createdAt: '2026-09-14T00:00:00.000Z',
              }))
              .concat(
                action === 'grant-deny'
                  ? [
                      {
                        id: 'deny-evidence',
                        behavior: 'deny',
                        target: {
                          kind: 'file-write',
                          path: 'delegation-evidence.txt',
                        },
                        origin: 'settings',
                        createdAt: '2026-09-16T00:00:00.000Z',
                      },
                    ]
                  : [],
              ),
          }
        : {}),
      ...(action === 'agent-capabilities'
        ? {
            rules: [
              {
                id: 'deny-selected-mcp-probe',
                behavior: 'deny',
                target: {
                  kind: 'mcp',
                  server: selectedMcpManagedName,
                  tool: 'denied_probe',
                },
                origin: 'settings',
                createdAt: '2026-09-16T00:00:00.000Z',
              },
            ],
          }
        : {}),
    });
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(
      path.join(userDataDir, 'preferences.json'),
      JSON.stringify({
        version: 1,
        preferences: {
          chatDetail: 'detailed',
          managedDelegationMode:
            action === 'proactive' ? 'proactive' : 'explicit-only',
          ...(action?.startsWith('nested')
            ? { managedDelegationMaxDepth: 2 }
            : {}),
          onboardingCompleted: ['v1'],
          defaultChatInterfaceMode: 'canopy',
          defaultWorktreeProvider: parent,
          defaultChatProvider: parent,
          codexMultiAgentWorktreeChatsEnabled: false,
        },
      }),
    );
    if (['agent', 'agent-capabilities', 'agent-follow-up'].includes(action)) {
      const skillDirectory = delegatedReviewSkillDirectory(userDataDir);
      mkdirSync(skillDirectory, { recursive: true });
      writeFileSync(
        path.join(skillDirectory, 'SKILL.md'),
        action === 'agent-capabilities'
          ? `---\nname: delegated-review\ndescription: Read the retained delegated review guidance.\nuser-invocable: true\n---\n\n# Independent review\n${fixture.canary}\nRetain the original error cause.\n`
          : `# Independent review\n${fixture.canary}\nRetain the original error cause.\n`,
      );
      if (action === 'agent' || action === 'agent-follow-up')
        seedAgentModels(userDataDir, [
          {
            id: 'agent_model_delegated_reviewer',
            name: 'Delegated reviewer',
            baseModel: child === 'claude' ? 'sonnet' : 'gpt-6.1-sol',
            instructions: `RETAINED_AGENT_REVIEW_INSTRUCTIONS: read ${delegationAgentSkillPath}, independently inspect error paths and return one concrete finding.`,
            pluginSelections: {
              collectionIds: [],
              skillRefs: [
                { sourceId: 'custom:app', skillName: 'delegated-review' },
              ],
              pluginRefs: [],
              mcpServerRefs:
                action === 'agent-follow-up'
                  ? [{ serverId: agentMcpServerId, configId: 'default' }]
                  : [],
            },
            createdAt: '2026-09-08T00:00:00.000Z',
            updatedAt: '2026-09-08T00:00:00.000Z',
          },
        ]);
      if (action === 'agent-capabilities') {
        const ambientSkillDirectory = path.join(
          userDataDir,
          'provider-state/codex/skills/ambient-review',
        );
        mkdirSync(ambientSkillDirectory, { recursive: true });
        writeFileSync(
          path.join(ambientSkillDirectory, 'SKILL.md'),
          '---\nname: ambient-review\ndescription: Parent-only ambient skill.\n---\n\nAMBIENT_SKILL_EVIDENCE\n',
        );
      }
    }
    seedWorktreeChat({
      userDataDir,
      workspaceId,
      worktreeId,
      tabs: [
        {
          id: 'delegating-parent',
          title: 'Delegating parent',
          providerType: parent,
          executionHarness: parent,
          model: parent === 'claude' ? 'claude-sonnet-4-6' : 'gpt-6.1-sol',
          approvalMode:
            action === 'grant-deny'
              ? 'auto'
              : [
                    'write-approval',
                    'command-approval',
                    'continuation-approval',
                    'nested-approval',
                    'nested-cancel',
                  ].includes(action)
                ? 'ask'
                : 'full-access',
          ...(autoArchive ? { autoArchive: true } : {}),
          ...(agentMcp
            ? {
                pluginSelections: {
                  collectionIds: [],
                  skillRefs: [],
                  pluginRefs: [],
                  mcpServerRefs: [
                    { serverId: ambientMcpServerId, configId: 'default' },
                  ],
                },
              }
            : {}),
        },
      ],
    });
    const launchEnv = {
      ...(action === 'initialization-cancel'
        ? { CANOPY_E2E_MANAGED_DELEGATION_INITIALIZATION_DELAY_MS: '2000' }
        : {}),
      CANOPY_MOCK_LLM_BASE_URL: fixture.url,
      ...(action === 'agent-capabilities'
        ? { UNRELATED_MANAGED_SECRET: 'host-secret' }
        : {}),
    };
    seedCodexFixtureModelCatalog(userDataDir);
    let { electronApp } = await launchCanopy({ userDataDir, env: launchEnv });
    let originalTimer;
    let nativeProcesses = [];
    let verifyQuit = false;
    let assertionsCompleted = false;
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      if (action === 'agent-capabilities') {
        await app.openMarketplaceAgents();
        await app.createMarketplaceAgent();
        const agentModal = window.getByTestId('agent-model-modal');
        await agentModal
          .getByTestId('agent-model-name')
          .fill('Delegated reviewer');
        await agentModal
          .getByTestId('agent-model-base-model')
          .getByTestId('chat-model-picker')
          .click();
        await selectModelOption(
          window,
          child === 'claude' ? 'sonnet' : 'gpt-6.1-sol',
        );
        await agentModal
          .getByTestId('agent-model-instructions')
          .fill(
            `RETAINED_AGENT_REVIEW_INSTRUCTIONS: read ${delegationAgentSkillPath}, call review_evidence, independently inspect error paths and return one concrete finding.`,
          );
        await agentModal.getByTestId('agent-model-plugins').click();
        const picker = window.getByTestId('plugin-picker-region');
        await expect(picker).toBeVisible();
        await picker
          .getByPlaceholder('Search by name…')
          .fill('delegated-review');
        await picker
          .getByRole('checkbox', {
            name: 'Select delegated-review',
            exact: true,
          })
          .check();
        await picker
          .getByPlaceholder('Search by name…')
          .fill('Delegated Review Tools');
        await picker
          .getByRole('checkbox', { name: 'Select Delegated Review Tools' })
          .check();
        await picker.getByPlaceholder('Search by name…').fill(agentPluginName);
        await picker
          .getByRole('checkbox', { name: `Select ${agentPluginName}` })
          .check();
        await picker
          .locator('xpath=ancestor::*[@role="dialog"][1]')
          .getByRole('button', { name: 'Save', exact: true })
          .click();
        await expect(agentModal).toContainText('delegated-review');
        await expect(agentModal).toContainText(agentMcpServerId);
        await expect(agentModal).toContainText(agentPluginName);
        await agentModal.getByTestId('agent-model-submit').click();
        await app.expectCreatedLocalAgentDetail(configuredAgentId);
        expect(
          JSON.parse(
            readFileSync(path.join(userDataDir, 'agent-models.json'), 'utf8'),
          ).agents[0],
        ).toMatchObject({
          id: configuredAgentId,
          baseModel: child === 'claude' ? 'sonnet' : 'gpt-6.1-sol',
          pluginSelections: {
            skillRefs: [
              { sourceId: 'custom:app', skillName: 'delegated-review' },
            ],
            mcpServerRefs: [
              { serverId: agentMcpServerId, configId: 'default' },
            ],
            pluginRefs: [
              {
                marketplaceId: agentPluginMarketplaceId,
                pluginName: agentPluginName,
              },
            ],
          },
        });
      }
      if (action === 'account-refresh') {
        const saved = await window.evaluate(() =>
          window.api.saveCanopyCloudApiKey({
            apiKey: 'csk_delegation_refresh_e2e',
          }),
        );
        expect(saved.status.authenticated).toBe(true);
        await window.evaluate(() =>
          window.api.refreshCanopyCloudEnforcedSettings(),
        );
      }
      await app.openMainPage();
      if (action === 'capacity-custom') {
        await app.openSettings();
        await app.openSettingsSection('experiments');
        await chooseSettingsOption(
          window.getByTestId('settings-managed-delegation-concurrency'),
          '2',
        );
        await expect
          .poll(() =>
            window.evaluate(
              async () =>
                (await window.api.loadPreferences())
                  .managedDelegationMaxConcurrent,
            ),
          )
          .toBe(2);
        await app.closeSettings();
      }
      await app.selectWorktree('demo-main');
      const panel = window.getByTestId('panel-content-chat');
      const verifyTerminalReload = async (label) => {
        const delivery = retainedRuns(userDataDir)[0].delivery;
        const showCard = async () => {
          await expect
            .poll(
              async () =>
                (await panel
                  .getByRole('button', { name: /^Agent steps:/ })
                  .count()) +
                (await panel.getByTestId('chat-delegated-agent').count()),
            )
            .toBeGreaterThan(0);
          const card = panel.getByTestId('chat-delegated-agent');
          await expect
            .poll(
              async () => {
                for (const summary of await panel
                  .getByRole('button', {
                    name: /^Agent steps:/,
                    expanded: false,
                  })
                  .all())
                  await summary.click();
                return card.count();
              },
              { timeout: scaled(15_000) },
            )
            .toBe(1);
          await expect(card).toContainText(label);
          return card;
        };
        await showCard();
        await window.reload();
        await app.waitForShell();
        await app.openMainPage();
        await app.selectWorktree('demo-main');
        await showCard();
        expect(retainedRuns(userDataDir)[0].delivery).toEqual(delivery);
      };
      const composer = window.getByRole('textbox').first();
      if (autoArchive)
        await expect
          .poll(async () => {
            const state = await window.evaluate(
              async ({ projectId, worktreeId }) =>
                window.api.chat.getState({ projectId, worktreeId }),
              { projectId: workspaceId, worktreeId },
            );
            return state.tabsFile.tabs.find(
              (tab) => tab.id === 'delegating-parent',
            )?.autoArchive;
          })
          .toBe(true);
      await composer.fill(
        `[${fixture.parentMarker}] Delegate an independent review with this scope: ${fixture.brief} Incorporate its finding.`,
      );
      await window.getByRole('button', { name: 'Send message' }).click();
      if (action?.startsWith('nested')) {
        await expect
          .poll(() => retainedRuns(userDataDir).length, {
            timeout: scaled(60_000),
          })
          .toBe(2);
        if (action === 'nested-approval' || action === 'nested-cancel') {
          const approval = window.getByTestId('tool-approval-card');
          await expect(approval).toBeVisible({ timeout: scaled(60_000) });
          await expect
            .poll(
              () =>
                retainedRuns(userDataDir).find((run) => run.depth === 2)?.state
                  .approvalPending,
            )
            .toBe(true);
          expect(
            fixture.requests.some(
              (request) =>
                request.role === 'grandchild' && request.hasNativeEvidence,
            ),
          ).toBe(false);
          if (action === 'nested-cancel') {
            // The composer's Stop ends only the root turn. The tree belongs
            // to the chat: the grandchild keeps running with its approval
            // pending and stays listed in the composer's background drawer.
            // (Its parent delegate already ended its own run after spawning
            // it in the background; that never stops a child.)
            await window.getByTestId('chat-stop-generation').click();
            await expect(
              window.getByTestId('chat-stop-generation'),
            ).toHaveCount(0, { timeout: scaled(30_000) });
            const survivors = await runsAfterParentStop(userDataDir);
            const first = survivors.find((run) => run.depth === 1);
            const nested = survivors.find((run) => run.depth === 2);
            expect(first.state.status).not.toBe('cancelled');
            expect(nested.state).toMatchObject({
              status: 'running',
              approvalPending: true,
            });
            await expect(approval).toBeVisible();
            const drawerRow = await drawerDelegateRow(
              window,
              nested.state.delegationId,
            );
            await expect(drawerRow).toBeVisible();
            // Its live snapshot's pending approval counts it as needing
            // input; the parent's saved card does not carry it.
            await expect(
              window
                .getByTestId('composer-work-drawer')
                .getByTestId('composer-work-drawer-toggle'),
            ).toContainText('Needs you 1', { timeout: scaled(30_000) });
            // The row Stop acts at once; the user's stop settles it
            // `Cancelled` and withdraws its pending approval.
            const rowStop = drawerRow.getByTestId('background-tray-agent-stop');
            await expect(rowStop).toHaveAccessibleName('Stop delegation');
            await rowStop.click();
            await expect
              .poll(
                () =>
                  retainedRuns(userDataDir).find((run) => run.depth === 2)
                    ?.state.status,
                { timeout: scaled(30_000) },
              )
              .toBe('cancelled');
            expect(
              retainedRuns(userDataDir).find((run) => run.depth === 2)?.state,
            ).toMatchObject({
              stopReason: 'user_cancelled',
              cancelledByUser: true,
              stoppedBy: { kind: 'user' },
            });
            await expect(approval).toHaveCount(0);
            // It leaves the drawer.
            await expect(drawerRow).toHaveCount(0);
            const nestedCard = delegatedCard(
              panel.getByTestId('chat-message-list-content'),
              nested.state.delegationId,
            );
            await expect(async () => {
              for (const summary of await panel
                .getByRole('button', { name: /^Agent steps:/, expanded: false })
                .all())
                await summary.click({ timeout: 2_000 });
              if (!(await nestedCard.first().isVisible())) {
                const toggle = delegatedCard(
                  panel.getByTestId('chat-message-list-content'),
                  first.state.delegationId,
                )
                  .getByRole('button', { name: 'Expand delegated task' })
                  .first();
                if (await toggle.isVisible())
                  await toggle.click({ timeout: 2_000 });
              }
              await expect(
                nestedCard
                  .first()
                  .getByTestId('delegated-agent-status')
                  .first(),
              ).toHaveText('Cancelled', { timeout: 1_000 });
            }).toPass({ timeout: scaled(30_000) });
            assertionsCompleted = true;
            return;
          }
          await approval.getByTestId('tool-approval-allow').click();
        }
        await expect
          .poll(
            () =>
              fixture.requests.some(
                (request) =>
                  request.role === 'grandchild' && request.hasNativeEvidence,
              ),
            { timeout: scaled(60_000) },
          )
          .toBe(true);
        const before = retainedRuns(userDataDir);
        const first = before.find((run) => run.depth === 1);
        const nested = before.find((run) => run.depth === 2);
        expect(nested.parentDelegationId).toBe(first.state.delegationId);
        expect(nested.parentRunGeneration).toBe(first.state.runGeneration);
        expect(nested.state.status).not.toBe('completed');
        const childTools = JSON.stringify(
          fixture.requests.find((request) => request.role === 'child')?.tools,
        );
        const leafTools = JSON.stringify(
          fixture.requests.find((request) => request.role === 'grandchild')
            ?.tools,
        );
        expect(childTools).toMatch(/DelegateTask|spawn_delegate/);
        expect(leafTools).not.toMatch(/DelegateTask|spawn_delegate/);
        fixture.releaseChild();
        await expect(
          panel.getByText(fixture.integrated, { exact: true }),
        ).toHaveCount(0);
        await expect
          .poll(
            () =>
              retainedRuns(userDataDir).every(
                (run) =>
                  run.state.status === 'completed' &&
                  run.delivery.status === 'suppressed',
              ),
            { timeout: scaled(20_000) },
          )
          .toBe(true);
        if (action === 'nested-resume') {
          writeFileSync(
            path.join(first.executionCwd, 'nested-location.txt'),
            `NESTED_ISOLATED_${caseId}`,
          );
          await composer.fill(
            `[${fixture.parentMarker}] NESTED_ROOT_RESUME ${nested.state.delegationId}`,
          );
          await window.getByRole('button', { name: 'Send message' }).click();
          await expect(
            panel
              .getByText(`${fixture.integrated} resumed`, { exact: true })
              .first(),
          ).toBeVisible({ timeout: scaled(60_000) });
          await expect
            .poll(
              () =>
                retainedRuns(userDataDir).find((run) => run.depth === 2)?.state
                  .runGeneration,
            )
            .toBe(2);
          expect(
            retainedRuns(userDataDir).find((run) => run.depth === 2)
              ?.inheritedCwd,
          ).toBe(first.executionCwd);
          expect(
            retainedRuns(userDataDir).find((run) => run.depth === 2)
              ?.parentRunGeneration,
          ).toBe(first.state.runGeneration);
        }
        if (action === 'nested-grant-attenuation') {
          await composer.fill(
            `[${fixture.parentMarker}] NESTED_ROOT_WIDEN ${nested.state.delegationId}`,
          );
          await window.getByRole('button', { name: 'Send message' }).click();
          await expect(
            panel.getByText(`${fixture.integrated} attenuated`, {
              exact: true,
            }),
          ).toBeVisible({ timeout: scaled(60_000) });
          expect(
            retainedRuns(userDataDir).find((run) => run.depth === 2),
          ).toMatchObject({
            task: {
              permissions: { writePaths: ['workspace/narrow/file.ts'] },
            },
            state: { runGeneration: 1 },
          });
        }
        if (action === 'nested-follow-up') {
          await expect
            .poll(
              () =>
                retainedRuns(userDataDir).find((run) => run.depth === 2)?.state
                  .runGeneration,
              { timeout: scaled(60_000) },
            )
            .toBe(2);
          await expect
            .poll(
              () =>
                retainedRuns(userDataDir).find((run) => run.depth === 2)?.state
                  .status,
              { timeout: scaled(60_000) },
            )
            .toBe('completed');
          expect(
            retainedRuns(userDataDir).find((run) => run.depth === 2)?.state
              .finalText,
          ).toContain(`FOLLOWED_UP_NESTED_EVIDENCE_${caseId}`);
        }
        if (action === 'nested-depth-lowered') {
          // The delegate finished before its child, so it wakes for the
          // child's completion notice. Let that run settle first, so the
          // resume below is the only new generation.
          await expect
            .poll(() =>
              fixture.requests.some(
                (request) =>
                  request.role === 'child' && request.hasDelegateNotice,
              ),
            )
            .toBe(true);
          await expect
            .poll(
              () =>
                retainedRuns(userDataDir).find((run) => run.depth === 1)?.state
                  .status,
            )
            .toBe('completed');
          const childRequestCount = fixture.requests.filter(
            (request) => request.role === 'child',
          ).length;
          await app.openSettings();
          await app.openSettingsSection('experiments');
          await chooseSettingsOption(
            window.getByTestId('settings-managed-delegation-depth'),
            '1',
          );
          await expect
            .poll(() =>
              window.evaluate(
                async () =>
                  (await window.api.loadPreferences())
                    .managedDelegationMaxDepth,
              ),
            )
            .toBe(1);
          await app.closeSettings();
          const generationBeforeResume = retainedRuns(userDataDir).find(
            (run) => run.depth === 1,
          ).state.runGeneration;
          await composer.fill(
            `[${fixture.parentMarker}] NESTED_DEPTH_LOWERED_RESUME ${first.state.delegationId}`,
          );
          await window.getByRole('button', { name: 'Send message' }).click();
          await expect(
            panel
              .getByText(`${fixture.integrated} resumed`, { exact: true })
              .first(),
          ).toBeVisible({ timeout: scaled(60_000) });
          await expect
            .poll(
              () =>
                retainedRuns(userDataDir).find((run) => run.depth === 1)?.state
                  .runGeneration,
            )
            .toBe(generationBeforeResume + 1);
          const resumedChildTools = JSON.stringify(
            fixture.requests
              .filter((request) => request.role === 'child')
              .slice(childRequestCount)
              .map((request) => request.toolNames),
          );
          expect(resumedChildTools).not.toMatch(/DelegateTask|spawn_delegate/);
        }
        if (action === 'nested' && parent === 'claude' && child === 'codex')
          expect(retainedCodexRollouts(userDataDir)).toHaveLength(1);
        // Each delegated card update is persisted ahead of the parent's own
        // terminal event, so the parent turn can still read as running after
        // every run has settled, and a turn collapses its steps when it
        // completes. Expand them only once the turn has completed.
        await expect(panel.getByTestId('turn-timer').last()).toHaveAttribute(
          'data-state',
          'completed',
          { timeout: scaled(30_000) },
        );
        const collapsedSteps = panel.getByRole('button', {
          name: /^Agent steps:/,
          expanded: false,
        });
        const stepCount = await collapsedSteps.count();
        for (let index = 0; index < stepCount; index++)
          await collapsedSteps.first().click();
        const cards = panel.getByTestId('chat-delegated-agent');
        // One card per run generation. A depth-1 delegate that finished before
        // its child wakes for the child's completion notice in a new
        // generation; one still running takes the notice as a steer instead.
        await expect
          .poll(async () => {
            const generations = retainedRuns(userDataDir).reduce(
              (sum, run) => sum + run.state.runGeneration,
              0,
            );
            return (await cards.count()) === generations ? generations : -1;
          })
          .toBeGreaterThanOrEqual(
            [
              'nested-resume',
              'nested-follow-up',
              'nested-depth-lowered',
            ].includes(action)
              ? 3
              : 2,
          );
        // The grandchild's completion notice must reach the depth-1 delegate,
        // which relays on up: the root chat later receives that delegate's
        // own completion notice.
        const firstChildNotice = () =>
          fixture.requests.findIndex(
            (request) => request.role === 'child' && request.hasDelegateNotice,
          );
        await expect.poll(firstChildNotice).toBeGreaterThanOrEqual(0);
        await expect
          .poll(() =>
            fixture.requests
              .slice(firstChildNotice() + 1)
              .some(
                (request) =>
                  request.role === 'parent' && request.hasDelegateNotice,
              ),
          )
          .toBe(true);
        const nestedCard = cards.filter({ hasText: 'Depth 2' }).last();
        await expect(nestedCard).toContainText('Parent:');
        await expect
          .poll(
            () =>
              retainedRuns(userDataDir).find((run) => run.depth === 2)?.state
                .status,
          )
          .toBe('completed');
        // The nested card is a sub-block of its parent card and can remount
        // (collapsed, result not yet projected) while the parent's transcript
        // settles, so expand and reveal the result until the evidence shows.
        await expect(async () => {
          const toggle = nestedCard.getByRole('button', {
            name: /^(Expand|Collapse) delegated task$/,
          });
          if (
            (await toggle.getAttribute('aria-expanded', { timeout: 2_000 })) !==
            'true'
          )
            await toggle.click({ timeout: 2_000 });
          const showResult = nestedCard.getByRole('button', {
            name: 'Show result',
            exact: true,
          });
          if (await showResult.isVisible())
            await showResult.click({ timeout: 2_000 });
          await expect(nestedCard).toContainText(`NESTED_EVIDENCE_${caseId}`, {
            timeout: 1_000,
          });
        }).toPass({ timeout: 60_000 });
        await window.reload();
        await app.waitForShell();
        await app.openMainPage();
        await app.selectWorktree('demo-main');
        await expect
          .poll(() =>
            retainedRuns(userDataDir).every(
              (run) => run.delivery.status === 'suppressed',
            ),
          )
          .toBe(true);
        assertionsCompleted = true;
        return;
      }
      if (action === 'project-context' || action === 'isolation') {
        await expect
          .poll(
            () => fixture.requests.some((request) => request.role === 'child'),
            { timeout: 120_000 },
          )
          .toBe(true);
        const childRequest = fixture.requests.find(
          (request) => request.role === 'child',
        );
        const childTools = JSON.stringify(childRequest?.tools ?? []);
        if (action === 'project-context') {
          // CLAUDE.md or AGENTS.md from the worktree reaches the child.
          expect(childRequest?.hasProjectInstructions).toBe(true);
          expect(childTools).toContain(
            child === 'claude'
              ? 'mcp__canopy__SearchMemory'
              : 'canopy_search_memory',
          );
          // Both harnesses run the parent worktree's scripts.
          expect(childTools).toContain(
            child === 'claude'
              ? 'mcp__canopy__DispatchAction'
              : 'canopy_dispatch_action',
          );
          // Watchers and wakeups notify the delegate itself.
          expect(childTools).toContain(
            child === 'claude'
              ? 'mcp__canopy__ScheduleWakeup'
              : 'canopy_schedule_wakeup',
          );
          // Both harnesses can register command watches.
          expect(childTools).toContain(
            child === 'claude'
              ? 'mcp__canopy__WatchCommand'
              : 'canopy_watch_command',
          );
          // App tools that change the user's UI stay with the parent.
          expect(childTools).not.toMatch(/ShowFiles|show_files/);
          expect(childRequest?.hasSetupHint).toBe(false);
        } else {
          // The isolated checkout skipped setup; the child is told how to run it.
          expect(childRequest?.hasSetupHint).toBe(true);
          expect(childRequest?.hasSetupCommand).toBe(true);
          // Script actions target the parent worktree, not this checkout.
          expect(childTools).not.toMatch(/DispatchAction|dispatch_action/);
        }
      }
      if (action === 'delegate-watch') {
        // The child registers a command watch in its own working directory
        // and finishes its first run.
        await expect
          .poll(
            () => ({
              generation: retainedRuns(userDataDir)[0]?.state.runGeneration,
              status: retainedRuns(userDataDir)[0]?.state.status,
            }),
            { timeout: 120_000 },
          )
          .toEqual({ generation: 1, status: 'completed' });
        const [registered] = retainedRuns(userDataDir);
        expect(registered.state.finalText).toBe(fixture.finding);
        // The user sees and manages the delegate's watcher on the root chat.
        const watching = window.getByTestId(
          'chat-input-watchers-delegating-parent',
        );
        await expect(watching).toBeVisible({ timeout: 30_000 });
        const listed = await window.evaluate(() =>
          window.api.appAdvisor.listWatchers(),
        );
        const ownerDescription = registered.task.description;
        expect(listed).toEqual([
          expect.objectContaining({
            trigger: 'command_watch_resolved',
            status: 'active',
            destination: expect.objectContaining({
              projectId: workspaceId,
              worktreeId,
              chatId: 'delegating-parent',
              // Agent-created watchers name the subscribing chat.
              chatTitle: 'Delegating parent',
              delegationId: registered.state.delegationId,
            }),
            ownerDelegate: {
              delegationId: registered.state.delegationId,
              description: ownerDescription,
              depth: 1,
            },
          }),
        ]);
        const watcherId = listed[0].id;
        // The tooltip and modal name the chat and the delegate that owns it.
        await watching.hover();
        await expect(
          window.getByTestId(
            `chat-input-watchers-delegating-parent-owner-${watcherId}`,
          ),
        ).toHaveText(`Delegate: ${ownerDescription} · depth 1`);
        await expect(
          window.getByTestId(
            `chat-input-watchers-delegating-parent-destination-${watcherId}`,
          ),
        ).toHaveText('Subscribed chat: Delegating parent');
        await watching.click();
        await expect(
          window.getByTestId(`watcher-management-destination-${watcherId}`),
        ).toHaveText('Delegating parent');
        await expect(
          window.getByTestId(`watcher-management-owner-${watcherId}`),
        ).toHaveText(`${ownerDescription} · depth 1`);
        await window.keyboard.press('Escape');
        await expect(
          window.getByTestId('watcher-management-modal'),
        ).toHaveCount(0);
        // The probe succeeds only in the delegate's working directory.
        writeFileSync(
          path.join(
            demo.workspaces[0].worktreePath,
            'delegate-watch-ready.txt',
          ),
          'ready',
        );
        await expect
          .poll(
            () =>
              fixture.requests.some(
                (request) =>
                  request.role === 'child' && request.hasWatcherEvent,
              ),
            { timeout: 60_000 },
          )
          .toBe(true);
        await expect
          .poll(
            () => ({
              generation: retainedRuns(userDataDir)[0]?.state.runGeneration,
              status: retainedRuns(userDataDir)[0]?.state.status,
            }),
            { timeout: 120_000 },
          )
          .toEqual({ generation: 2, status: 'completed' });
        expect(retainedRuns(userDataDir)[0].state.finalText).toBe(
          `WATCHER_DELIVERED_${caseId}`,
        );
        // The fired message went to the delegate, never to the root chat.
        expect(
          fixture.requests.some(
            (request) =>
              request.role === 'parent' && request.hasCommandWatcherEvent,
          ),
        ).toBe(false);
        await expect(panel.getByText(/watcher fired/i)).toHaveCount(0);
        await expect(watching).toHaveCount(0);
        expect(fixture.errors).toEqual([]);
        assertionsCompleted = true;
        return;
      }
      if (action === 'grant-deny') {
        // The folder grant is denied by the saved rule. Approving the later
        // command must still leave the filesystem write blocked by the sandbox.
        const commandApproval = window
          .getByTestId('tool-approval-card')
          .filter({ hasText: 'printf' });
        await expect(commandApproval).toBeVisible({ timeout: scaled(60_000) });
        expect(
          fixture.requests
            .filter((request) => request.role === 'child')
            .map((request) => request.results)
            .join('\n'),
        ).toContain('file_system\\":null');
        await commandApproval.getByTestId('tool-approval-allow').click();
      }
      if (action === 'command-native-rules') {
        await expect
          .poll(
            () =>
              fixture.requests.some(
                (request) =>
                  request.role === 'child' && request.hasNativeEvidence,
              ),
            { timeout: scaled(60_000) },
          )
          .toBe(true);
        await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
      }
      if (action === 'command-approval') {
        const allow = window.getByTestId('tool-approval-allow');
        await expect(allow).toBeVisible({ timeout: scaled(60_000) });
        expect(
          fixture.requests.some(
            (request) => request.role === 'child' && request.hasNativeEvidence,
          ),
        ).toBe(false);
        await expect
          .poll(() => retainedRuns(userDataDir)[0]?.state.approvalPending)
          .toBe(true);
        await allow.click();
        await expect
          .poll(() =>
            fixture.requests.some(
              (request) =>
                request.role === 'child' && request.hasNativeEvidence,
            ),
          )
          .toBe(true);
        await expect(
          window
            .getByTestId('tool-approval-card')
            .filter({ hasText: 'DENIED_COMMAND_CANARY' }),
        ).toBeVisible({ timeout: scaled(30_000) });
        await window.getByTestId('tool-approval-deny').click();
        await expect
          .poll(
            () =>
              fixture.requests.filter((request) => request.role === 'child')
                .length,
          )
          .toBeGreaterThanOrEqual(3);
        expect(
          fixture.requests
            .filter((request) => request.role === 'child')
            .some((request) =>
              request.results.includes('DENIED_COMMAND_CANARY'),
            ),
        ).toBe(false);
      }
      if (action === 'initialization-cancel') {
        await expect
          .poll(() =>
            fixture.requests.some((request) => request.role === 'parent'),
          )
          .toBe(true);
        await window.getByTestId('chat-stop-generation').click();
        await expect(
          window.getByTestId('chat-stop-generation'),
        ).not.toBeVisible();
        fixture.releaseParentInitialization();
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(
          fixture.requests.some((request) => request.role === 'child'),
        ).toBe(false);
        expect(retainedRuns(userDataDir)).toEqual([]);
        assertionsCompleted = true;
        return;
      }
      if (action === 'restraint') {
        await expect(
          panel.getByText(fixture.integrated, { exact: true }),
        ).toBeVisible({ timeout: scaled(120_000) });
        expect(retainedRuns(userDataDir)).toEqual([]);
        expect(
          fixture.requests.some((request) => request.role === 'child'),
        ).toBe(false);
        assertionsCompleted = true;
        return;
      }
      if (action === 'cancel') {
        await expect
          .poll(
            () =>
              fixture.requests.some(
                (request) =>
                  request.role === 'child' && request.hasNativeEvidence,
              ),
            { timeout: scaled(120_000) },
          )
          .toBe(true);
        // Require the child's real native inference connection, held after
        // reading the canary. Parent CLIs can exit on parent Stop; the shared
        // Codex app server can outlive a cancelled child thread.
        await expect
          .poll(() => fixture.childConnections.length, {
            timeout: scaled(30_000),
          })
          .toBeGreaterThan(0);
        const childConnections = [...fixture.childConnections];
        // The composer's Stop ends only the parent turn; the delegate keeps
        // running, with its confined native processes, until the user stops
        // it.
        await window.getByTestId('chat-stop-generation').click();
        await expect(window.getByTestId('chat-stop-generation')).toHaveCount(
          0,
          { timeout: scaled(30_000) },
        );
        expect(
          (await runsAfterParentStop(userDataDir)).map(
            (run) => run.state.status,
          ),
        ).toEqual(['running']);
        expect(childConnections.every((connection) => !connection.closed)).toBe(
          true,
        );
        if (child === 'claude') {
          // Parent-owned discovery probes may exit with the parent turn.
          // Capture the surviving child CLI, then require its cleanup when
          // that child is stopped below.
          nativeProcesses = nativeDescendants(electronApp.process().pid).filter(
            (entry) => windowsImageName(entry.command) === 'claude',
          );
          expect(nativeProcesses.length).toBeGreaterThan(0);
        }
        // A background delegate is listed in the composer's background
        // drawer, with its Stop; a foreground one keeps its Stop on the
        // transcript card.
        const rowStop =
          mode === 'background'
            ? (await drawerDelegateRow(panel)).getByTestId(
                'background-tray-agent-stop',
              )
            : await revealDelegatedStop(panel);
        await expect(rowStop).toHaveAccessibleName('Stop delegation');
        await rowStop.click();
        await expect
          .poll(() => retainedRuns(userDataDir)[0]?.state.status)
          .toBe('cancelled');
        expect(retainedRuns(userDataDir)[0]?.state).toMatchObject({
          stopReason: 'user_cancelled',
          cancelledByUser: true,
          stoppedBy: { kind: 'user' },
        });
        await expect
          .poll(() => childConnections.every((connection) => connection.closed))
          .toBe(true);
        if (child === 'claude')
          await expect
            .poll(() => runningNativeProcesses(nativeProcesses))
            .toEqual([]);
        expect(retainedRuns(userDataDir)[0]?.delivery.status).toBe(
          'suppressed',
        );
        await verifyTerminalReload('Cancelled');
        assertionsCompleted = true;
        return;
      }
      if (action === 'stop') {
        await expect(
          panel.getByText(fixture.integrated, { exact: true }),
        ).toBeVisible({ timeout: scaled(120_000) });
        await expect
          .poll(() => retainedRuns(userDataDir)[0]?.state.status)
          .toBe('cancelled');
        // The parent agent stopped it through StopDelegate, not the user.
        expect(retainedRuns(userDataDir)[0]?.state).toMatchObject({
          stopReason: 'stopped_by_parent',
          cancelledByUser: false,
          stoppedBy: { kind: 'agent', depth: 0 },
          error: { code: 'terminated_by_parent' },
        });
        expect(retainedRuns(userDataDir)[0]?.delivery.status).toBe(
          'suppressed',
        );
        // An agent stop reads as such, not as the user's `Cancelled`.
        await verifyTerminalReload('Stopped by parent');
        assertionsCompleted = true;
        return;
      }
      if (action === 'async') {
        await expect(
          panel.getByText(fixture.continued, { exact: true }),
        ).toBeVisible({ timeout: scaled(15_000) });
        expect(retainedRuns(userDataDir)[0]?.state.status).not.toBe(
          'completed',
        );
        if (!action && !policy && !autoArchive) {
          await expect.poll(() => retainedTimers(userDataDir).length).toBe(1);
          await expect(panel.getByTestId('turn-timer')).toHaveAttribute(
            'data-state',
            'completed',
          );
          await expect
            .poll(() => retainedTimers(userDataDir)[0]?.completedAt != null)
            .toBe(true);
          [originalTimer] = retainedTimers(userDataDir);
        }
        fixture.releaseChild();
      }
      if (mode === 'background') {
        if (action !== 'continuation-approval')
          await expect(
            panel.getByText(fixture.continued, { exact: true }),
          ).toBeVisible({ timeout: scaled(120_000) });
        if (action === 'write-approval') {
          await expect
            .poll(() => retainedRuns(userDataDir)[0]?.state.approvalPending, {
              timeout: scaled(30_000),
            })
            .toBe(true);
          await expect(window.getByTestId('tool-approval-allow')).toBeVisible();
          expect(
            readFileSync(
              path.join(
                demo.workspaces[0].worktreePath,
                'delegation-evidence.txt',
              ),
              'utf8',
            ),
          ).not.toContain('Explicit child edit');
          await window.getByTestId('tool-approval-allow').click();
          if (child === 'codex') {
            // Granting file access does not preapprove the command that writes it.
            const commandApproval = window
              .getByTestId('tool-approval-card')
              .filter({ hasText: 'printf' });
            await expect(commandApproval).toBeVisible({
              timeout: scaled(30_000),
            });
            await commandApproval.getByTestId('tool-approval-allow').click();
          }
        }
        if (!action && !policy && !autoArchive) {
          for (const summary of await panel
            .getByRole('button', { name: /^Agent steps:/, expanded: false })
            .all())
            await summary.click();
          await expect(await drawerDelegateRow(panel)).toBeVisible();
          const delegated = panel.getByTestId('chat-delegated-agent').first();
          await expect(delegated).toBeVisible();
          await expect(
            delegated.locator(
              '[data-step-row-words].canopy-text-shimmer-strong',
            ),
          ).toBeVisible();
          await expect(delegated).toContainText(child);
        }
        await expect
          .poll(() => retainedRuns(userDataDir)[0]?.state.status)
          .toMatch(/^(pending|running)$/);
        if (action === 'account-refresh') {
          await expect
            .poll(
              () =>
                fixture.requests.some(
                  (request) =>
                    request.role === 'child' && request.hasNativeEvidence,
                ),
              { timeout: scaled(120_000) },
            )
            .toBe(true);
          const before = await window.evaluate(() =>
            window.api.loadCanopyCloudAccount(),
          );
          await app.openSettings();
          await app.openSettingsSection('privacy');
          await expect(
            window.getByTestId('settings-tab-privacy'),
          ).toBeVisible();
          await expect
            .poll(
              async () =>
                (
                  await window.evaluate(() =>
                    window.api.loadCanopyCloudAccount(),
                  )
                ).updatedAt,
            )
            .not.toBe(before.updatedAt);
          expect(retainedRuns(userDataDir)[0]?.state.status).toBe('running');
          await app.closeSettings();
        }
        if (action === 'policy-change' || action === 'setting-off') {
          await expect
            .poll(
              () =>
                fixture.requests.some(
                  (request) =>
                    request.role === 'child' && request.hasNativeEvidence,
                ),
              { timeout: scaled(120_000) },
            )
            .toBe(true);
          if (action === 'setting-off') {
            await app.openSettings();
            await app.openSettingsSection('experiments');
            await chooseSettingsOption(
              window.getByTestId('settings-managed-delegation-mode'),
              'off',
            );
            await expect
              .poll(() =>
                window.evaluate(
                  async () =>
                    (await window.api.loadPreferences()).managedDelegationMode,
                ),
              )
              .toBe('off');
          } else {
            await window.getByTestId('approval-mode-picker').click();
            await window.getByTestId('approval-mode-option-ask').click();
          }
          if (action === 'policy-change') {
            // Leaving Full Access recycles the parent session, not the chat:
            // the delegate keeps running under the chat's live approval mode.
            await expect
              .poll(async () => {
                const state = await window.evaluate(
                  async ({ projectId, worktreeId }) =>
                    window.api.chat.getState({ projectId, worktreeId }),
                  { projectId: workspaceId, worktreeId },
                );
                return state.tabsFile.tabs.find(
                  (tab) => tab.id === 'delegating-parent',
                )?.approvalMode;
              })
              .toBe('ask');
            await new Promise((resolve) => setTimeout(resolve, scaled(2_000)));
            expect(retainedRuns(userDataDir)[0]?.state.status).toBe('running');
            // The downgrade applies to the delegate at once: the command it
            // runs next, which Full Access would have allowed, now asks.
            fixture.releaseChild();
            const downgraded = window
              .getByTestId('tool-approval-card')
              .filter({ hasText: 'POLICY_DOWNGRADE_CANARY' });
            await expect(downgraded).toBeVisible({ timeout: scaled(60_000) });
            await downgraded.getByTestId('tool-approval-deny').click();
            await expect
              .poll(() => retainedRuns(userDataDir)[0]?.state.status, {
                timeout: scaled(60_000),
              })
              .toBe('completed');
            expect(retainedRuns(userDataDir)[0]?.state.finalText).toBe(
              fixture.finding,
            );
            // The denied command never ran (as in the command-approval case, a
            // declined command's result does not echo the command).
            expect(
              fixture.requests
                .filter((request) => request.role === 'child')
                .some((request) =>
                  request.results.includes('POLICY_DOWNGRADE_CANARY'),
                ),
            ).toBe(false);
            assertionsCompleted = true;
            return;
          }
          // Turning delegation off revokes authority: the tree stops.
          await expect
            .poll(() => retainedRuns(userDataDir)[0]?.state.status)
            .toBe('cancelled');
          expect(retainedRuns(userDataDir)[0]?.delivery.status).toBe(
            'suppressed',
          );
          assertionsCompleted = true;
          return;
        }
        if (action === 'quit' || action?.startsWith('capacity')) {
          await expect
            .poll(
              () =>
                fixture.requests.some(
                  (request) =>
                    request.role === 'child' && request.hasNativeEvidence,
                ),
              { timeout: scaled(120_000) },
            )
            .toBe(true);
          if (action?.startsWith('capacity')) {
            const expectedRunning = action === 'capacity-custom' ? 2 : 5;
            await expect
              .poll(
                () =>
                  retainedRuns(userDataDir).filter(
                    (run) => run.state.status === 'running',
                  ).length,
              )
              .toBe(expectedRunning);
            const capacityRuns = retainedRuns(userDataDir);
            expect(capacityRuns).toHaveLength(6);
            expect(
              capacityRuns.filter(
                (run) =>
                  run.state.status === 'pending' &&
                  run.admission?.state === 'waiting',
              ),
            ).toHaveLength(6 - expectedRunning);
            expect(
              fixture.requests
                .filter((request) => request.role === 'parent')
                .map((request) => request.results)
                .join('\n'),
            ).not.toContain('capacity_exceeded');
          }
          nativeProcesses = nativeDescendants(electronApp.process().pid);
          expect(nativeProcesses.length).toBeGreaterThan(0);
          verifyQuit = true;
          assertionsCompleted = true;
          return;
        }
        if (action === 'watch') {
          const results = fixture.requests
            .filter((request) => request.role === 'parent')
            .map((request) => request.results)
            .join('\n');
          // Fresh tool lists omit Watch Delegates, so the harness refuses a
          // stale call before Canopy sees it; the completion notice still
          // wakes the parent (checked with the integrated result below).
          expect(results).toMatch(
            parent === 'claude'
              ? /No such tool available: \S*WatchDelegates/
              : /unsupported call: \S*watch_delegates/,
          );
          expect(results).not.toContain('watcherId');
          expect(results).toContain('currentRunGeneration');
          expect(results).not.toContain('timedOut');
        }
        if (action === 'model-change') {
          await panel.getByTestId('chat-model-picker').click();
          await selectModelOption(window, 'gpt-5.6-sol');
          await expect(panel.getByTestId('chat-model-picker')).toContainText(
            'GPT 5.6 Sol',
          );
          await composer.fill(`[${fixture.parentMarker}] MODEL_SWITCH_PROBE`);
          await window.getByRole('button', { name: 'Send message' }).click();
          await expect
            .poll(
              () =>
                fixture.requests
                  .filter(
                    (request) =>
                      request.role === 'parent' && request.harness === 'codex',
                  )
                  .at(-1)?.model,
            )
            .toBe('gpt-5.6-sol');
        }
        if (action === 'long-running') {
          await expect
            .poll(() => Date.now() - retainedRuns(userDataDir)[0].createdAt, {
              timeout: scaled(150_000),
              intervals: [1_000],
            })
            .toBeGreaterThan(125_000);
          expect(retainedRuns(userDataDir)[0].state.status).toBe('running');
        }
        if (!action && !policy && !autoArchive) {
          await expect.poll(() => retainedTimers(userDataDir).length).toBe(1);
          await expect(panel.getByTestId('turn-timer')).toHaveAttribute(
            'data-state',
            'completed',
          );
          await expect
            .poll(() => retainedTimers(userDataDir)[0]?.completedAt != null)
            .toBe(true);
          [originalTimer] = retainedTimers(userDataDir);
        }
        if (action === 'continuation-approval') {
          // Completion needs no tool call or approval before ending the turn.
          await expect(
            window
              .getByTestId('tool-approval-card')
              .filter({ hasText: 'WatchDelegates' }),
          ).toHaveCount(0);
          await expect.poll(() => retainedTimers(userDataDir).length).toBe(1);
        }
        fixture.releaseChild();
      }
      await expect
        .poll(
          () =>
            [
              'completed',
              'failed',
              'cancelled',
              'deadline_exceeded',
              'interrupted',
            ].includes(retainedRuns(userDataDir)[0]?.state.status),
          { timeout: action === 'long-running' ? 150_000 : 120_000 },
        )
        .toBe(true);
      if (action === 'continuation-approval') {
        const outputApproval = window.getByTestId('tool-approval-card').filter({
          hasText:
            parent === 'claude'
              ? 'GetDelegateOutput'
              : codexToolName('get_delegate_output'),
        });
        await expect(outputApproval).toBeVisible({ timeout: scaled(60_000) });
        await outputApproval.getByTestId('tool-approval-allow').click();
        await expect.poll(() => retainedTimers(userDataDir).length).toBe(2);
        originalTimer = retainedTimers(userDataDir).at(-1);
        const releasedOwnerIds = [];
        for (const step of [1, 2]) {
          const card = window.getByTestId('tool-approval-card');
          await expect(card).toBeVisible({ timeout: scaled(60_000) });
          await expect(card).toContainText(
            parent === 'claude' ? 'GetScriptOutput' : `approval-timer-${step}`,
          );
          await expect(panel.getByTestId('turn-timer').last()).toHaveAttribute(
            'data-state',
            'paused',
          );
          // The canonical turn holds exactly this prompt's pause: the second
          // prompt must not retain the already-released first owner.
          await expect
            .poll(() => openPauseOwnerIds(userDataDir)?.length)
            .toBe(1);
          const [ownerId] = openPauseOwnerIds(userDataDir);
          expect(releasedOwnerIds).not.toContain(ownerId);
          releasedOwnerIds.push(ownerId);
          await card.getByTestId('tool-approval-allow').click();
        }
        await expect(panel.getByTestId('turn-timer').last()).toHaveAttribute(
          'data-state',
          'live',
        );
        await expect.poll(() => openPauseOwnerIds(userDataDir)).toEqual([]);
        fixture.releaseContinuation();
        await expect(
          panel.getByText(fixture.integrated, { exact: true }),
        ).toBeVisible({ timeout: scaled(60_000) });
        await expect(panel.getByTestId('turn-timer').last()).toHaveAttribute(
          'data-state',
          'completed',
        );
        await expect
          .poll(() => retainedTimers(userDataDir).at(-1)?.completedAt != null)
          .toBe(true);
        const completed = retainedTimers(userDataDir);
        expect(completed).toHaveLength(2);
        // The continuation completes the same timer rather than a new one.
        const finalTimer = completed.at(-1);
        expect(finalTimer.id).toBe(originalTimer.id);
        expect(finalTimer.accumulatedPausedDurationMs).toBeGreaterThanOrEqual(
          originalTimer.accumulatedPausedDurationMs ?? 0,
        );
        // Turn-end effects write the completed timer with no pause owners.
        expect(finalTimer.pauseOwnerIds ?? []).toEqual([]);
        // The approval waits are counted once. A turn that waited on the user
        // keeps its original start when it completes (CAN-4996), so the
        // timer's elapsed time is its own span less the same pauses the turn
        // recorded; it never includes them again.
        const endedTurn = endedTurnRecord(userDataDir);
        expect(endedTurn?.id).toBe(finalTimer.turnId);
        // Pauses count only within the turn: Codex reports its end at whole
        // seconds, so the last approval can close after the recorded end.
        let pausedMs = 0;
        let coveredUntil = endedTurn.startedAtMs;
        for (const pause of [...endedTurn.pauses].sort(
          (left, right) => left.startedAtMs - right.startedAtMs,
        )) {
          const from = Math.max(pause.startedAtMs, coveredUntil);
          const to = Math.min(pause.endedAtMs, endedTurn.endedAtMs);
          if (to > from) pausedMs += to - from;
          coveredUntil = Math.max(coveredUntil, to);
        }
        expect(finalTimer.accumulatedPausedDurationMs).toBe(pausedMs);
        expect(finalTimer.startedAt).toBe(originalTimer.startedAt);
        // Net of the waits, the timer's span is the host-measured active time
        // since its start: including a wait again would exceed it by that
        // wait, and the provider may report its end at whole seconds.
        const timerActiveMs =
          finalTimer.completedAt -
          finalTimer.startedAt -
          finalTimer.accumulatedPausedDurationMs;
        expect(timerActiveMs).toBeGreaterThanOrEqual(0);
        expect(timerActiveMs).toBeLessThanOrEqual(
          endedTurn.endedAtMs - finalTimer.startedAt - pausedMs + 2_000,
        );
        // A provider measures from its own start and may report its end at
        // whole seconds, so allow two seconds beyond the host-measured active
        // time; a duration that still included the waits would exceed it by
        // the whole paused total.
        expect(endedTurn.durationMs).toBeLessThanOrEqual(
          endedTurn.endedAtMs - endedTurn.startedAtMs - pausedMs + 2_000,
        );
        await window.reload();
        await app.waitForShell();
        await app.openMainPage();
        await app.selectWorktree('demo-main');
        await expect(
          panel.getByText(fixture.integrated, { exact: true }),
        ).toBeVisible();
        await expect(panel.getByTestId('turn-timer').last()).toHaveAttribute(
          'data-state',
          'completed',
        );
        expect(retainedTimers(userDataDir)).toEqual(completed);
        assertionsCompleted = true;
        return;
      }
      if (action === 'partial-failure') {
        const run = retainedRuns(userDataDir)[0];
        expect(run.state.status).toBe('failed');
        expect(run.state.error?.message).toContain(
          'Deterministic child failure after partial output',
        );
        await verifyTerminalReload('Failed');
        await composer.fill(
          `[${fixture.parentMarker}] FAILURE_OUTPUT_PROBE ${run.state.delegationId}`,
        );
        await window.getByRole('button', { name: 'Send message' }).click();
        await expect
          .poll(
            () =>
              fixture.requests
                .filter((request) => request.role === 'parent')
                .map((request) => request.results)
                .join('\n'),
            { timeout: scaled(60_000) },
          )
          .toContain('Deterministic child failure after partial output');
        expect(run.state.nativeSessionId).toEqual(expect.any(String));
        if (action === 'partial-failure') {
          expect(run.state.partialText).toContain(fixture.partial);
          expect(run.state.usage).toMatchObject({
            inputTokens: expect.any(Number),
            outputTokens: expect.any(Number),
          });
          await expect
            .poll(() => retainedRuns(userDataDir)[0]?.delivery.status, {
              timeout: scaled(30_000),
            })
            .toBe('suppressed');
        }
        expect(
          nativeDescendants(electronApp.process().pid).filter(isFileBroker),
        ).toEqual([]);
        assertionsCompleted = true;
        return;
      }
      expect(retainedRuns(userDataDir)[0]?.state).toMatchObject({
        status: 'completed',
      });
      if (action === 'command-native-rules') {
        expect(
          fixture.requests
            .filter((request) => request.role === 'child')
            .map((request) => request.results)
            .join('\n'),
        ).toContain('policy forbids commands starting with');
        await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
      }
      if (mode === 'background' && !action && !policy && !autoArchive) {
        await expect(
          panel.getByText(fixture.integrated, { exact: true }),
        ).toHaveCount(0);
        // The child's completion notice may already have woken the idle parent
        // in a turn of its own (asserted below); the original turn is unchanged.
        expect(retainedTimers(userDataDir)[0]).toEqual(originalTimer);
      }

      if (action?.startsWith('resume')) {
        await expect
          .poll(
            () => ({
              generation: retainedRuns(userDataDir)[0]?.state.runGeneration,
              status: retainedRuns(userDataDir)[0]?.state.status,
            }),
            { timeout: scaled(120_000) },
          )
          .toEqual({ generation: 2, status: 'completed' });
        const retained = retainedRuns(userDataDir)[0];
        expect(retained.history).toHaveLength(1);
        // Codex can materialize a fresh native thread while replaying the
        // retained history. The original session remains the resume source.
        expect(retained.resumeSessionId).toEqual(expect.any(String));
        expect(retained.state.finalText).toContain(`RESUMED_${fixture.canary}`);
      }
      if (action === 'isolation-conflict') {
        const evidence = path.join(
          demo.workspaces[0].worktreePath,
          'delegation-evidence.txt',
        );
        const parentResults = () =>
          fixture.requests
            .filter((request) => request.role === 'parent')
            .map((request) => request.results)
            .join('\n');
        // The parent model receives the failure, its reason, and the diff to
        // forward. The fixture holds the parent here until released.
        await expect
          .poll(() => parentResults().includes('apply_failed'), {
            timeout: 120_000,
          })
          .toBe(true);
        expect(parentResults()).toContain('parent_changed');
        expect(parentResults()).toContain('+// Parent edit');
        expect(readFileSync(evidence, 'utf8')).toMatch(/\/\/ Parent edit\n$/);
        expect(readFileSync(evidence, 'utf8')).not.toContain(
          'Explicit child edit',
        );
        const failed = retainedRuns(userDataDir)[0];
        expect(failed.control).toMatchObject({
          operation: 'apply',
          status: 'failed',
          applyFailure: {
            reason: 'conflict',
            issues: [
              { path: 'delegation-evidence.txt', reason: 'parent_changed' },
            ],
          },
        });
        expect(failed.workspaceDiscarded).toBeUndefined();
        expect(existsSync(failed.executionCwd)).toBe(true);
        fixture.releaseConflictRetry();
        await expect
          .poll(() => retainedRuns(userDataDir)[0]?.control, {
            timeout: 120_000,
          })
          .toMatchObject({ operation: 'apply', status: 'completed' });
        expect(readFileSync(evidence, 'utf8')).toBe(
          `// ${fixture.canary}\n// Explicit child edit\n// Parent edit\n`,
        );
        expect(
          readFileSync(
            path.join(demo.workspaces[0].worktreePath, 'parent-only.txt'),
            'utf8',
          ),
        ).toBe('Parent dirty changes must survive.');
      }
      if (action === 'isolation') {
        await expect
          .poll(() => retainedRuns(userDataDir)[0]?.control, {
            timeout: scaled(30_000),
          })
          .toMatchObject({ status: 'completed' });
        const retained = retainedRuns(userDataDir)[0];
        expect(retained.task.isolation).toBe('worktree');
        expect(retained.executionCwd).not.toBe(demo.workspaces[0].worktreePath);
        expect(existsSync(retained.executionCwd)).toBe(true);
        expect(
          readFileSync(
            path.join(demo.workspaces[0].worktreePath, 'parent-only.txt'),
            'utf8',
          ),
        ).toBe('Parent dirty changes must survive.');
        // The card reads the delegate's changes from its worktree on request.
        const delegated = await revealDelegatedAgent(panel);
        await delegated
          .getByRole('button', { name: 'Expand delegated task' })
          .click();
        await delegated.getByRole('button', { name: 'Show changes' }).click();
        const changed = delegated.getByTestId('delegated-change');
        await expect(changed).toHaveCount(1);
        await expect(changed.locator('summary')).toHaveText(
          'delegation-evidence.txt · modified',
        );
        await changed.locator('summary').click();
        // Removing the large file's padding fills the bounded display diff.
        if (largeEvidence)
          await expect(changed).toContainText('Diff shortened to fit');
        else
          await expect(changed.locator('pre')).toContainText(
            '+// Explicit child edit',
          );
      }
      if (action === 'grant-deny') {
        expect(
          readFileSync(
            path.join(
              demo.workspaces[0].worktreePath,
              'delegation-evidence.txt',
            ),
            'utf8',
          ),
        ).not.toContain('Explicit child edit');
        expect(
          fixture.requests
            .filter((request) => request.role === 'child')
            .map((request) => request.results)
            .join('\n'),
        ).toMatch(/Operation not permitted|Permission denied|denied/i);
      }
      if (
        ['write', 'write-approval', 'isolation', 'shell-append'].includes(
          action,
        )
      ) {
        expect(
          readFileSync(
            path.join(
              demo.workspaces[0].worktreePath,
              'delegation-evidence.txt',
            ),
            'utf8',
          ),
        ).toContain('Explicit child edit');
        // Git tracks the edit; the run keeps no copy of the file's text.
        expect(retainedRuns(userDataDir)[0]?.state).not.toHaveProperty(
          'fileChanges',
        );
      }
      if (action === 'shell-append') {
        const evidence = readFileSync(
          path.join(demo.workspaces[0].worktreePath, 'delegation-evidence.txt'),
          'utf8',
        );
        // Appended in place: the original evidence survives above the line.
        expect(evidence.startsWith(`// ${fixture.canary}\n`)).toBe(true);
        expect(evidence.endsWith('// Explicit child edit\n')).toBe(true);
        const childResults = fixture.requests
          .filter((request) => request.role === 'child')
          .map((request) => request.results)
          .join('\n');
        expect(childResults).not.toMatch(
          /operation not permitted|permission denied|read-only file system/i,
        );
        // The fixture never asks for a request_permissions turn grant here,
        // so the task's write grant alone let the sandbox accept the append,
        // and nothing prompted for it.
        await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
      }
      expect(retainedRuns(userDataDir)[0]?.state.finalText).toBe(
        action?.startsWith('resume')
          ? `${fixture.finding} RESUMED_${fixture.canary}`
          : fixture.finding,
      );
      if (policy === 'native-git-write' || policy === 'native-file-write') {
        const results = fixture.requests
          .filter((request) => request.role === 'child')
          .map((request) => request.results)
          .join('\n');
        expect(results).toMatch(
          /Operation not permitted|Permission denied|Access is denied|Access to the path .+ is denied/i,
        );
        expect(results).not.toMatch(/command not found/i);
        expect(
          existsSync(
            path.join(
              demo.workspaces[0].worktreePath,
              'forbidden-shell-write.txt',
            ),
          ),
        ).toBe(false);
        expect(
          execFileSync('git', ['branch', '--list', 'readonly-boundary-probe'], {
            cwd: demo.workspaces[0].worktreePath,
            encoding: 'utf8',
          }),
        ).toBe('');
        expect(
          execFileSync('git', ['config', '--local', '--list'], {
            cwd: demo.workspaces[0].worktreePath,
            encoding: 'utf8',
          }),
        ).not.toContain('delegation.forbidden');
      }
      if (action?.startsWith('git-history')) {
        if (child === 'codex')
          expect(
            fixture.requests.some(
              (request) =>
                request.role === 'child' && request.hasGitCommandInstructions,
            ),
          ).toBe(true);
        const results = fixture.requests
          .filter((request) => request.role === 'child')
          .map((request) => request.results)
          .join('\n');
        expect(results).toContain('READ_ONLY_GIT_CONFIG');
        expect(results).toContain('READ_ONLY_WORKTREE_CONFIG');
        if (child === 'codex') {
          expect(lateGitSiblingCreated).toBe(true);
          expect(results).toContain('SIBLING_METADATA_DENIED');
          expect(results).not.toContain('SIBLING_PRIVATE_CONFIG');
          expect(results).not.toContain('SIBLING_METADATA_EXPOSED');
        }
        expect(results).not.toMatch(
          /command not found|not a git repository|Operation not permitted|Exit code [1-9]/i,
        );
      }
      const watcherCompletion =
        action === 'watch' ||
        action === 'isolation' ||
        action === 'isolation-conflict' ||
        action === 'continuation-approval' ||
        action?.startsWith('resume') === true;
      if (!autoArchive && !watcherCompletion)
        await expect(
          panel.getByText(fixture.integrated, { exact: true }),
        ).toHaveCount(0);
      else if (!autoArchive)
        await expect(
          panel.getByText(fixture.integrated, { exact: true }),
        ).toBeVisible({ timeout: scaled(30_000) });
      await expect
        .poll(() => retainedRuns(userDataDir)[0]?.delivery.status, {
          timeout: scaled(30_000),
        })
        .toBe('suppressed');
      if (!action && !policy && !autoArchive) {
        // The finished delegate notifies its parent without a watch: the
        // parent gets the notice and the chat shows its row.
        await expect
          .poll(
            () =>
              fixture.requests.some(
                (request) =>
                  request.role === 'parent' && request.hasDelegateNotice,
              ),
            { timeout: scaled(30_000) },
          )
          .toBe(true);
        await expect(
          panel.getByText(/delegate finished watcher has fired/i),
        ).toBeVisible({
          timeout: scaled(30_000),
        });
      }
      if (action === 'session-reuse') {
        const parentRequestsBefore = fixture.requests.filter(
          (request) => request.role === 'parent',
        ).length;
        fixture.armNextDelegation();
        await composer.fill(
          `[${fixture.parentMarker}] Delegate the same independent review again on this reused chat session.`,
        );
        await window.getByRole('button', { name: 'Send message' }).click();
        await expect
          .poll(
            () =>
              retainedRuns(userDataDir).filter(
                (run) =>
                  run.state.status === 'completed' &&
                  run.delivery.status === 'suppressed',
              ).length,
            { timeout: scaled(120_000) },
          )
          .toBe(2);
        expect(
          fixture.requests.filter(
            (request) => request.role === 'child' && request.hasNativeEvidence,
          ),
        ).toHaveLength(2);
        expect(
          fixture.requests
            .filter((request) => request.role === 'parent')
            .slice(parentRequestsBefore)
            .some((request) => request.hasPriorIntegrated),
        ).toBe(false);
        expect(fixture.errors).toEqual([]);
        assertionsCompleted = true;
        return;
      }
      const runs = retainedRuns(userDataDir);
      expect(runs).toHaveLength(1);
      expect(runs[0].workspaceObservation).toMatchObject({
        consistency: 'live_shared_worktree',
        headRevision: initialHeadRevision,
        dirty: true,
        observedAt: expect.any(Number),
      });
      expect(runs[0].workspaceObservation.observedAt).toBeGreaterThanOrEqual(
        runs[0].createdAt,
      );
      if (action !== 'watch')
        expect(
          fixture.requests.some(
            (request) =>
              request.role === 'parent' && request.hasWorkspaceObservation,
          ),
        ).toBe(watcherCompletion);
      if (action === 'discovery') {
        await expect
          .poll(() =>
            retainedMetrics(userDataDir).map((metric) => metric.event),
          )
          .toEqual(['invocation', 'terminal']);
        const metrics = retainedMetrics(userDataDir);
        expect(metrics[0]).toMatchObject({
          requestedThinkingLevel: 'high',
          status: 'accepted',
        });
        expect(metrics[1]).toMatchObject({
          status: 'completed',
          durationMs: expect.any(Number),
        });
        writeFileSync(
          testInfo.outputPath('delegation-metrics.json'),
          JSON.stringify(metrics, null, 2),
        );
        const discovery = fixture.requests
          .filter((request) => request.role === 'parent')
          .map((request) => request.results)
          .join('\n');
        expect(discovery).toMatch(/supportedThinkingLevels/);
        expect(discovery).toMatch(/recommendedModelId/);
        expect(discovery).toMatch(/authState/);
      }
      if (action === 'proactive') {
        expect(
          JSON.stringify(
            fixture.requests
              .filter((request) => request.role === 'parent')
              .map((request) => request.tools),
          ),
        ).toContain('You may proactively consult');
      }
      if (action === 'fast') {
        expect(
          fixture.requests
            .filter((request) => request.role === 'child')
            .map((request) => request.serviceTier),
        ).toEqual(expect.arrayContaining(['priority']));
        expect(runs[0].task.fastMode).toBe(true);
      }
      expect(runs[0].state).toMatchObject({
        status: 'completed',
        finalText: action?.startsWith('resume')
          ? `${fixture.finding} RESUMED_${fixture.canary}`
          : fixture.finding,
        nativeSessionId: expect.any(String),
      });
      expect(runs[0].route).toMatchObject({
        selectedModelId: [
          'agent',
          'agent-capabilities',
          'agent-follow-up',
        ].includes(action)
          ? 'agent_model_delegated_reviewer'
          : child === 'claude'
            ? 'sonnet'
            : 'gpt-6.1-sol',
        harnessId: child,
        effectiveThinkingLevel: 'high',
      });
      expect(runs[0].delivery).toEqual({
        status: 'suppressed',
        reason: 'automatic_delivery_removed',
      });
      if (action === 'command-approval') {
        for (const reload of [false, true]) {
          if (reload) {
            await window.reload();
            await app.waitForShell();
            await app.openMainPage();
            await app.selectWorktree('demo-main');
            await expect(
              panel.getByText(fixture.integrated, { exact: true }),
            ).toHaveCount(0);
          }
          // The run is durably complete, but the parent turn may still be
          // live (its card shows directly), completing (it collapses as it
          // settles), or re-hydrating after a reload. Retry the reveal as a
          // unit instead of snapshotting whatever happens to be rendered.
          const collapsedTurns = panel.getByRole('button', {
            name: /^Agent steps:/,
            expanded: false,
          });
          const delegated = panel.getByTestId('chat-delegated-agent').first();
          await expect(async () => {
            // Expanding a summary drops it from this `expanded: false` query,
            // so always take the first remaining one.
            while ((await collapsedTurns.count()) > 0)
              await collapsedTurns.first().click();
            const expand = delegated.getByRole('button', {
              name: 'Expand delegated task',
            });
            if (await expand.isVisible()) await expand.click();
            await delegated
              .getByRole('button', { name: 'Show result', exact: true })
              .click({ timeout: 2_000 });
          }).toPass({ timeout: scaled(30_000) });
          const denied = delegated
            .locator('[data-tool-name="Bash"]')
            .filter({ hasText: 'DENIED_COMMAND_CANARY' });
          await expect(denied).toHaveAttribute('data-tool-status', 'error');
          await denied.getByRole('button').first().click();
          await expect(denied).toContainText(
            child === 'claude'
              ? 'Delegated task permissions and parent approval policy'
              : 'declined',
          );
          await expect(
            delegated
              .locator('[data-tool-name="Bash"]')
              .filter({ hasText: 'delegation-evidence.txt' }),
          ).toHaveAttribute('data-tool-status', 'success');
        }
      }

      if (!action && !policy && !autoArchive) {
        await expect(panel.getByTestId('background-tray-agent')).toHaveCount(0);
        await expect(
          panel.getByText(/A delegated task has finished/),
        ).toHaveCount(0);
        const delegated = await revealDelegatedAgent(panel);
        await expect(
          delegated.locator('[data-step-row-words].canopy-text-shimmer-strong'),
        ).toHaveCount(0);
        await expect(
          delegated.getByText('Completed', { exact: true }),
        ).toHaveCount(0);
        await delegated
          .getByRole('button', { name: 'Expand delegated task' })
          .click();
        await delegated
          .getByRole('button', { name: 'Show result', exact: true })
          .click();
        await expect(
          delegated.getByText(fixture.finding, { exact: true }),
        ).toHaveCount(1);
        await expect(delegated).toContainText(
          child === 'claude' ? 'Read' : 'Ran',
        );
        await expect(delegated).toContainText('high');
        await window.reload();
        await app.waitForShell();
        await app.openMainPage();
        await app.selectWorktree('demo-main');
        await expect(
          window.getByText(fixture.integrated, { exact: true }),
        ).toHaveCount(0);
        await expect(
          window.getByText(/A delegated task has finished/),
        ).toHaveCount(0);
        const restored = await revealDelegatedAgent(window);
        await expect(
          restored.locator('[data-step-row-words].canopy-text-shimmer-strong'),
        ).toHaveCount(0);
        await restored
          .getByRole('button', { name: 'Expand delegated task' })
          .click();
        await restored
          .getByRole('button', { name: 'Show result', exact: true })
          .click();
        await expect(
          restored.getByText(fixture.finding, { exact: true }),
        ).toHaveCount(1);
        await expect(restored).toContainText(
          child === 'claude' ? 'Read' : 'Ran',
        );
        expect(retainedRuns(userDataDir)[0].delivery).toEqual(runs[0].delivery);
        if (mode === 'foreground') {
          await closeCanopy(electronApp, userDataDir, { keepUserData: true });
          ({ electronApp } = await launchCanopy({
            userDataDir,
            env: launchEnv,
          }));
          const coldWindow = await electronApp.firstWindow();
          const coldApp = new CanopyAppDriver(coldWindow);
          await coldApp.waitForShell();
          await coldApp.openMainPage();
          await coldApp.selectWorktree('demo-main');
          await expect(
            coldWindow.getByText(fixture.integrated, { exact: true }),
          ).toHaveCount(0);
          const coldCard = await revealDelegatedAgent(coldWindow);
          await expect(
            coldCard.locator(
              '[data-step-row-words].canopy-text-shimmer-strong',
            ),
          ).toHaveCount(0);
          await coldCard
            .getByRole('button', { name: 'Expand delegated task' })
            .click();
          await coldCard
            .getByRole('button', { name: 'Show result', exact: true })
            .click();
          await expect(
            coldCard.getByText(fixture.finding, { exact: true }),
          ).toHaveCount(1);
          await expect(
            coldWindow.getByText(/A delegated task has finished/),
          ).toHaveCount(0);
          await expect(coldCard).toContainText(
            child === 'claude' ? 'Read' : 'Ran',
          );
          expect(retainedRuns(userDataDir)[0].delivery).toEqual(
            runs[0].delivery,
          );
          // The first turn after a restart starts a fresh managed session,
          // which replays the retained delegation against the parent's
          // transcript before the parent can answer.
          await coldWindow
            .getByRole('textbox')
            .first()
            .fill(
              `[${fixture.parentMarker}] COLD_RESTART_FOLLOW_UP Answer without delegating.`,
            );
          await coldWindow
            .getByRole('button', { name: 'Send message' })
            .click();
          await expect(
            coldWindow.getByText(fixture.coldFollowUp, { exact: true }),
          ).toBeVisible({ timeout: scaled(60_000) });
          await expect(
            coldWindow.getByText(
              'The managed session could not start or finish its owned cleanup.',
            ),
          ).toHaveCount(0);
        }
      }
      if (['agent', 'agent-capabilities', 'agent-follow-up'].includes(action)) {
        expect(retainedSkillRemoved).toBe(true);
        expect(
          fixture.requests
            .filter((request) => request.role === 'child')
            .every((request) => request.hasAgentInstructions),
        ).toBe(true);
      }
      if (action === 'agent-capabilities') {
        expect(
          fixture.requests.some(
            (request) => request.role === 'parent' && request.hasAmbientMcpTool,
          ),
        ).toBe(true);
        expect(
          fixture.requests
            .filter((request) => request.role === 'parent')
            .every(
              (request) =>
                !request.hasSelectedMcpTool &&
                !request.hasSelectedPluginMcpTool,
            ),
        ).toBe(true);
        expectInheritedAmbientMcp(retainedRuns(userDataDir)[0], child, fixture);
        expect(
          fixture.requests.some(
            (request) => request.role === 'child' && request.hasSelectedMcpTool,
          ),
        ).toBe(true);
        expect(
          fixture.requests.some(
            (request) =>
              request.role === 'child' && request.hasSelectedPluginMcpTool,
          ),
        ).toBe(true);
        expect(agentMcp.calls).toContainEqual(
          expect.objectContaining({
            path: '/agent',
            name: 'review_evidence',
          }),
        );
        expect(agentMcp.calls.some((call) => call.path === '/ambient')).toBe(
          false,
        );
        expect(
          agentMcp.calls.some((call) => call.name === 'denied_probe'),
        ).toBe(false);
        expect(
          fixture.requests.some(
            (request) => request.role === 'child' && request.hasDeniedMcpResult,
          ),
        ).toBe(true);
        expect(readFileSync(agentPluginLog, 'utf8')).toContain('plugin_review');
        // The host broker launches a delegate's stdio MCP servers with the
        // parent's launch environment (MCP parity), so a host variable reaches
        // the plugin server exactly as it would for the parent chat.
        expect(readFileSync(agentPluginLog, 'utf8')).toContain(
          'ENV_PROBE=host-secret',
        );
        if (child === 'claude') {
          expect(
            fixture.requests
              .filter((request) => request.role === 'child')
              .every((request) => request.hasNativeSkillTool),
          ).toBe(true);
          expect(
            fixture.requests.some(
              (request) =>
                request.role === 'child' &&
                request.hasStandaloneSkillLaunch &&
                request.hasStandaloneSkillContext,
            ),
          ).toBe(true);
          expect(
            fixture.requests.some(
              (request) =>
                request.role === 'child' &&
                request.hasPluginSkillLaunch &&
                request.hasPluginSkillContext,
            ),
          ).toBe(true);
        } else
          expect(
            fixture.requests
              .filter((request) => request.role === 'child')
              .every(
                (request) =>
                  request.hasCodexSkillListTool &&
                  request.hasCodexSkillReadTool,
              ),
          ).toBe(true);
        if (child === 'codex')
          expect(
            fixture.requests
              .filter((request) => request.role === 'child')
              .some(
                (request) =>
                  request.hasAmbientSkillCatalog ||
                  request.hasAmbientSkillContext,
              ),
          ).toBe(false);
        if (child === 'codex') {
          expect(
            fixture.requests.some(
              (request) =>
                request.role === 'child' && request.hasStandaloneSkillResult,
            ),
          ).toBe(true);
          expect(
            fixture.requests.some(
              (request) =>
                request.role === 'child' && request.hasPluginSkillResult,
            ),
          ).toBe(true);
        }
        expect(
          fixture.requests
            .filter((request) => request.role === 'parent')
            .some((request) => request.hasAgentInstructions),
        ).toBe(false);
      }
      if (!policy)
        expect(
          fixture.requests.some(
            (request) => request.role === 'child' && request.hasNativeEvidence,
          ),
        ).toBe(true);
      else {
        const results = fixture.requests
          .filter((request) => request.role === 'child')
          .map((request) => request.results)
          .join('\n');
        expect(results).not.toContain(fixture.privateCanary);
        expect(results).toMatch(
          /denied|disabled|no such tool|unavailable|not available|unsupported|not found|unknown|invalid|not allowed|not permitted|no matches found/i,
        );
      }
      if (action === 'background-task') {
        const childResults = fixture.requests
          .filter((request) => request.role === 'child')
          .map((request) => request.results)
          .join('\n');
        // Shell detachment was refused with guidance toward the managed task.
        expect(childResults).toContain('Shell backgrounding and detachment');
        expect(childResults).toContain('run_in_background');
        // The managed background task ran, and its output file was readable.
        expect(childResults).toContain(`BACKGROUND_OUTPUT_${caseId}`);
      }
      if (action === 'resume-native-write') {
        expect(
          existsSync(
            path.join(
              demo.workspaces[0].worktreePath,
              'unauthorized-native.txt',
            ),
          ),
        ).toBe(false);
        expect(
          fixture.requests
            .filter((request) => request.role === 'child')
            .map((request) => request.results)
            .join('\n'),
        ).toMatch(/denied|rejected|not.*allow|permission|outside/i);
      }
      expect(fixture.errors).toEqual([]);
      for (const request of fixture.requests.filter(
        (entry) => entry.role === 'child',
      )) {
        const names = request.toolNames.map((name) => name.split('.').at(-1));
        expect(
          names.some((name) =>
            /delegation_(read|search|write)/.test(name ?? ''),
          ),
        ).toBe(false);
        expect(
          names.some((name) =>
            /(?:^|__)(?:RequestSteering)$|(?:^|_)request_steering$/.test(
              name ?? '',
            ),
          ),
        ).toBe(true);
        if (
          child === 'claude' &&
          !['agent-capabilities', 'agent-follow-up'].includes(action)
        )
          expect(
            names.filter(
              (name) =>
                ![
                  'Read',
                  'Grep',
                  'Glob',
                  'Edit',
                  'Write',
                  'Bash',
                  'TaskStop',
                  'Skill',
                  // Claude Code 2.1.310+ keeps deferred tool loading active
                  // with this never-callable placeholder.
                  'DeferredToolPlaceholder',
                ].includes(name) &&
                !/(?:^|__)RequestSteering$/.test(name ?? '') &&
                !delegateAppToolName.test(name ?? ''),
            ),
          ).toEqual([]);
        else expect(names).not.toEqual(expect.arrayContaining(['spawn_agent']));
      }
      if (autoArchive) {
        await expect
          .poll(
            async () => {
              const state = await window.evaluate(
                async ({ projectId, worktreeId }) =>
                  window.api.chat.getState({ projectId, worktreeId }),
                { projectId: workspaceId, worktreeId },
              );
              return {
                live: state.tabsFile.tabs.some(
                  (tab) => tab.id === 'delegating-parent',
                ),
                archived: state.archives.some(
                  (entry) => entry.chatId === 'delegating-parent',
                ),
              };
            },
            { timeout: scaled(15_000) },
          )
          .toEqual({ live: false, archived: true });
      }
      if (action === 'agent-follow-up') {
        const firstRun = runs[0];
        await app.openMarketplaceAgents();
        await app.deleteMarketplaceAgent(configuredAgentId);
        await expect(
          window.getByRole('heading', { name: 'Delete agent', exact: true }),
        ).toBeVisible();
        await window.getByRole('button', { name: 'Delete agent' }).click();
        await expect(
          window.getByTestId(`customize-row-agent:local:${configuredAgentId}`),
        ).toHaveCount(0);
        await app.openMainPage();
        await app.selectWorktree('demo-main');
        await composer.fill(
          `[${fixture.parentMarker}] AGENT_RETENTION_FOLLOW_UP delegationId ${firstRun.state.delegationId}. Continue the existing delegated review after its Agent definition was deleted.`,
        );
        await window.getByRole('button', { name: 'Send message' }).click();
        await expect
          .poll(() => retainedRuns(userDataDir)[0]?.state.runGeneration, {
            timeout: scaled(120_000),
          })
          .toBe(2);
        await expect
          .poll(() => retainedRuns(userDataDir)[0]?.state.finalText, {
            timeout: scaled(120_000),
          })
          .toBe(`FOLLOW_UP_RETAINED_${caseId}`);
        const resumed = retainedRuns(userDataDir)[0];
        expect(resumed.route.agentOverlay.artifact.artifactId).toBe(
          firstRun.route.agentOverlay.artifact.artifactId,
        );
        expect(resumed.route.agentOverlay.agentDefinitionHash).toBe(
          firstRun.route.agentOverlay.agentDefinitionHash,
        );
        expect(
          resumed.state.transcript.some(
            (entry) =>
              entry.type === 'tool' &&
              ['Read', 'Bash'].includes(entry.toolName) &&
              entry.output?.includes(fixture.canary),
          ),
        ).toBe(true);
        expect(agentMcp.calls).toContainEqual(
          expect.objectContaining({ path: '/agent', name: 'review_evidence' }),
        );
        expect(agentMcp.calls).toHaveLength(1);
        expectInheritedAmbientMcp(retainedRuns(userDataDir)[0], child, fixture);
        expect(
          fixture.requests.some(
            (request) => request.role === 'child' && request.hasSelectedMcpTool,
          ),
        ).toBe(true);
        if (child === 'claude') {
          const systemRoots = fixture.requests
            .filter((request) => request.role === 'child')
            .map((request) => request.systemRoots?.at(-1))
            .filter(Boolean);
          expect(systemRoots.length).toBeGreaterThanOrEqual(2);
          expect(systemRoots.at(-1)).not.toBe(systemRoots[0]);
        }
        expect(
          fixture.requests
            .filter((request) => request.role === 'child')
            .every((request) => request.hasAgentInstructions),
        ).toBe(true);
      }
      await testInfo.attach('retained-delegation', {
        body: JSON.stringify(runs, null, 2),
        contentType: 'application/json',
      });
      assertionsCompleted = true;
    } finally {
      if (!verifyQuit) fixture.releaseChild();
      fixture.releaseContinuation();
      await testInfo.attach('native-inference-requests', {
        body: JSON.stringify(
          { requests: fixture.requests, errors: fixture.errors },
          null,
          2,
        ),
        contentType: 'application/json',
      });
      await testInfo.attach('retained-runs-on-close', {
        body: JSON.stringify(retainedRuns(userDataDir), null, 2),
        contentType: 'application/json',
      });
      if (action?.startsWith('git-history')) {
        const receipts = [
          ['rev-parse', '--git-dir'],
          ['rev-parse', 'HEAD'],
          ['for-each-ref', '--format=%(refname) %(objectname)'],
        ].map((args) => {
          try {
            return {
              args,
              stdout: execFileSync('git', args, {
                cwd: demo.workspaces[0].worktreePath,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
              }),
            };
          } catch (error) {
            return {
              args,
              error: String(error),
              stderr: String(error.stderr ?? ''),
            };
          }
        });
        writeFileSync(
          testInfo.outputPath('git-metadata-on-close.json'),
          JSON.stringify(receipts, null, 2),
        );
      }
      const keepFailureData = !assertionsCompleted;
      if (keepFailureData)
        await testInfo.attach('failure-user-data-directory', {
          body: userDataDir,
          contentType: 'text/plain',
        });
      // The data directory above stays on the runner. When the child could
      // not reach the plugin's MCP tool, these say whether the provider ever
      // started the plugin's server and what it was given to load.
      if (keepFailureData && agentPluginLog) {
        let capabilityState;
        try {
          capabilityState = agentPluginCapabilityState(
            userDataDir,
            agentPluginLog,
          );
        } catch (error) {
          // Evidence only: never replace the failure being reported.
          capabilityState = { error: String(error) };
        }
        // Written as a file so it is uploaded with the shard's test results.
        const capabilityStatePath = testInfo.outputPath(
          'agent-plugin-capability-state.json',
        );
        writeFileSync(
          capabilityStatePath,
          JSON.stringify(capabilityState, null, 2),
        );
        await testInfo.attach('agent-plugin-capability-state', {
          path: capabilityStatePath,
          contentType: 'application/json',
        });
      }
      const verifyQuitState = (check = expect) => {
        check(
          retainedRuns(userDataDir).every(
            (run) =>
              run.state.status === 'cancelled' &&
              run.delivery.status === 'suppressed',
          ),
        ).toBe(true);
        check(runningNativeProcesses(nativeProcesses)).toEqual([]);
      };
      // closeCanopy only calls reapTree on Windows when Playwright's close
      // fails, so Windows verifies the quit after close instead. It keeps the
      // user data until then.
      const deferQuitCleanup = verifyQuit && hostPlatform === 'win32';
      let quitVerified = false;
      await closeCanopy(electronApp, userDataDir, {
        keepUserData: keepFailureData || deferQuitCleanup,
        ...(action?.startsWith('capacity')
          ? { gracefulCloseTimeoutMs: 30_000 }
          : {}),
        reapTree: async (pid) => {
          try {
            if (verifyQuit) {
              quitVerified = true;
              verifyQuitState();
            }
          } finally {
            await reapSupervisedProcessTree(pid);
          }
        },
      });
      let quitFailed = false;
      if (deferQuitCleanup && !quitVerified) {
        // Soft assertions fail the test without throwing from `finally`.
        const failures = testInfo.errors.length;
        verifyQuitState(expect.soft);
        quitFailed = testInfo.errors.length > failures;
        if (quitFailed)
          await testInfo.attach('failure-user-data-directory', {
            body: userDataDir,
            contentType: 'text/plain',
          });
      }
      if (deferQuitCleanup && !keepFailureData && !quitFailed) {
        await removeTestDataDir(userDataDir);
        await removeTestDataDir(`${userDataDir}-secure`);
      }
      await agentMcp?.close();
      await fixture.close();
      if (!keepFailureData && !quitFailed) cleanupDemoWorkspaces(demo);
    }
  });
}

for (const parent of ['claude', 'codex']) {
  test(`${parent} cowork parent remains ineligible for managed delegation`, async ({}, testInfo) => {
    test.setTimeout(scaled(120_000));
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'delegation-cowork-scope-'),
    );
    const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const fixture = await createDelegationInference({
      parent,
      child: 'claude',
      mode: 'background',
      caseId: `cowork-${parent}`,
      action: 'restraint',
    });
    const coworkId = 'delegation-ineligible-cowork';
    const entryId = 'scope-entry';
    const writeJson = (file, value) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(value));
    };
    const indexPath = path.join(userDataDir, 'workspaces/index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const collection = Array.isArray(index.items)
      ? index.items
      : index.workspaces;
    collection.push({
      id: coworkId,
      name: 'Delegation scope',
      type: 'cowork',
      color: '#7C9B6D',
      collapsed: false,
      order: collection.length,
      cowork: { createdAt: '2026-09-08T00:00:00.000Z' },
    });
    writeJson(indexPath, index);
    const directory = path.join(userDataDir, 'workspaces', coworkId);
    mkdirSync(path.join(directory, 'home'), { recursive: true });
    writeJson(path.join(directory, 'workspace.json'), {
      version: 1,
      type: 'cowork',
      cowork: {
        createdAt: '2026-09-08T00:00:00.000Z',
        defaultModel: parent === 'claude' ? 'claude-sonnet-4-6' : 'gpt-6.1-sol',
        searchIndexingEnabled: false,
      },
    });
    writeJson(path.join(directory, 'work-entries.json'), {
      version: 1,
      entries: [{ id: entryId, createdAt: '2026-09-08T00:00:00.000Z' }],
    });
    writeJson(path.join(userDataDir, 'preferences.json'), {
      version: 1,
      preferences: {
        managedDelegationMode: 'explicit-only',
        onboardingCompleted: ['v1'],
        defaultChatInterfaceMode: 'canopy',
        defaultWorktreeProvider: parent,
        defaultChatProvider: parent,
        codexMultiAgentWorktreeChatsEnabled: false,
      },
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId: coworkId,
      worktreeId: entryId,
      tabs: [
        {
          id: 'scope-chat',
          title: 'Scope test',
          kind: 'chat',
          messages: [
            {
              id: 'prior-user',
              role: 'user',
              timestamp: 1788825600000,
              blocks: [
                {
                  type: 'text',
                  text: 'Keep this existing cowork conversation available.',
                },
              ],
            },
            {
              id: 'prior-reply',
              role: 'assistant',
              timestamp: 1788825601000,
              blocks: [{ type: 'text', text: 'Ready for the next request.' }],
            },
          ],
          providerType: parent,
          executionHarness: parent,
          model: parent === 'claude' ? 'claude-sonnet-4-6' : 'gpt-6.1-sol',
          approvalMode: 'full-access',
        },
      ],
    });
    seedCodexFixtureModelCatalog(userDataDir);
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_MOCK_LLM_BASE_URL: fixture.url,
      },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      const toggle = window.getByTestId(
        `sidebar-cowork-project-${coworkId}-toggle`,
      );
      await expect(toggle).toBeVisible();
      if ((await toggle.getAttribute('aria-expanded')) !== 'true')
        await toggle.click();
      await window.getByTestId(`sidebar-work-entry-${entryId}`).click();
      await window
        .getByRole('textbox')
        .first()
        .fill(
          `[${fixture.parentMarker}] Answer this simple request directly without delegating.`,
        );
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect(
        window.getByText(fixture.integrated, { exact: true }),
      ).toBeVisible({ timeout: scaled(90_000) });
      const requests = fixture.requests.filter(
        (request) => request.role === 'parent',
      );
      expect(requests.length).toBeGreaterThan(0);
      const advertised = JSON.stringify(
        requests.map((request) => request.toolNames),
      );
      expect(advertised).not.toContain(codexToolName('spawn_delegate'));
      expect(advertised).not.toContain(claudeToolName('DelegateTask'));
      expect(fixture.requests.some((request) => request.role === 'child')).toBe(
        false,
      );
    } finally {
      await testInfo.attach('native-surface-requests', {
        body: JSON.stringify(fixture.requests),
        contentType: 'application/json',
      });
      await closeCanopy(electronApp, userDataDir);
      await fixture.close();
      cleanupDemoWorkspaces(demo);
    }
  });
}
