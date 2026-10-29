// Deterministic inference only. Provider binaries, application tools, file
// access, routing, persistence and native receipts all execute through
// production paths (same guarantee as `managed-delegation.spec.mjs`).
//
// Covers capabilities for delegates (docs/planning/2026-09-26-delegation-swarm-cleanup/01-wave-1.md
// §1.1, §2.1-2.4, §2.6): children inherit the root chat's plugins/skills/MCP
// servers by default, `inherit_capabilities: false` opts out, `capabilities`
// assigns catalog items explicitly, children get Search/Load Deferred Tools
// when the root chat allows deferred tools, and a Load reloads capabilities
// inside the same run generation without publishing an extra result.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect as baseExpect, test } from '@playwright/test';

// See managed-delegation.spec.mjs: Windows qualification runs x64 Electron
// and provider binaries under ARM emulation, several times slower than macOS.
const TIMEOUT_SCALE = process.platform === 'win32' ? 3 : 1;
const scaled = (ms) => ms * TIMEOUT_SCALE;
const expect = baseExpect.configure({ timeout: scaled(15_000) });

import { CanopyAppDriver } from './canopyApp.mjs';
import {
  seedDemoWorkspaces,
  cleanupDemoWorkspaces,
} from './demoWorkspaces.mjs';
import {
  seedWorktreeChat,
  seedWorkspaceApprovals,
  writeJson,
} from './seeders/index.mjs';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { seedCodexFixtureModelCatalog } from './seeders/seedCodexFixtureModelCatalog.mjs';
import {
  claudeToolName,
  codexToolName,
  createDelegationInference,
} from './delegationRuntime.mjs';
import {
  baseManagedDelegationPreferences,
  driveParentWatchFlow,
  findDeferredSearchRef,
  findListDelegatesCapabilityId,
  hasToolName,
  retainedDelegationRuns,
  revealDelegatedAgent,
} from './fixtures/delegation-capabilities/helpers.mjs';
import { seedCapabilitySkill } from './fixtures/delegation-capabilities/skillFixture.mjs';
import {
  seedCapabilityMcpServer,
  startCapabilityMcpFixture,
} from './fixtures/delegation-capabilities/mcpFixture.mjs';

test.skip(
  !['darwin', 'win32'].includes(process.platform),
  'Managed delegation requires the macOS or Windows confined file boundary.',
);

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const TAB_ID = 'delegating-parent';

/**
 * Seed an isolated user data dir + demo worktree + chat tab, start the
 * scripted inference fixture, launch Canopy, and land on the worktree's chat
 * panel with the composer ready. `tabOverrides` layers onto the tab (e.g.
 * `pluginSelections`, `deferredToolsAllowed`); `setup` runs after the demo
 * workspace and preferences are seeded but before the chat tab, so a case can
 * seed its own skill/MCP fixtures first.
 */
async function launchDelegationCase({
  testInfo,
  caseId,
  action,
  child = 'claude',
  tabOverrides = {},
  script,
  setup,
  env = {},
}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-delegation-capabilities-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    defaultMode: 'full-access',
  });
  writeJson(
    path.join(userDataDir, 'preferences.json'),
    baseManagedDelegationPreferences({ parentProvider: 'claude' }),
  );
  await setup?.(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    tabs: [
      {
        id: TAB_ID,
        title: 'Delegating parent',
        providerType: 'claude',
        executionHarness: 'claude',
        model: 'claude-sonnet-4-6',
        approvalMode: 'full-access',
        ...tabOverrides,
      },
    ],
  });
  const fixture = await createDelegationInference({
    parent: 'claude',
    child,
    mode: 'foreground',
    caseId,
    action,
    script,
    // Debug aid: persist the requests captured so far on every turn, so a
    // hung or timed-out run still leaves a readable trace under the
    // Playwright output directory (mirrors the `testInfo.attach` the main
    // spec does at close, but written incrementally rather than only once
    // the run reaches its `finally` block).
    onRequest: (requests) => {
      try {
        writeFileSync(
          testInfo.outputPath('inference-requests.json'),
          JSON.stringify(requests, null, 2),
        );
      } catch {
        // Best-effort debug artifact only; never fail the case over it.
      }
    },
  });
  seedCodexFixtureModelCatalog(userDataDir);
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { ...env, CANOPY_MOCK_LLM_BASE_URL: fixture.url },
  });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  const panel = window.getByTestId('panel-content-chat');
  const composer = window.getByRole('textbox').first();
  return {
    userDataDir,
    demo,
    fixture,
    electronApp,
    window,
    app,
    panel,
    composer,
  };
}

/** Type the user's delegation request and send it. */
async function sendDelegationRequest(composer, window, fixture, brief) {
  await composer.fill(`[${fixture.parentMarker}] ${brief}`);
  await window.getByRole('button', { name: 'Send message' }).click();
}

/** Standard teardown mirroring `managed-delegation.spec.mjs`'s simple cases. */
async function teardown({
  electronApp,
  userDataDir,
  demo,
  fixture,
  extraFixtures = [],
}) {
  for (const extra of extraFixtures) await extra?.close();
  await fixture.close();
  await closeCanopy(electronApp, userDataDir);
  cleanupDemoWorkspaces(demo);
}

test.describe('managed delegation capabilities', () => {
  test("inherited-capabilities: a plain child inherits the root chat's skill and MCP server", async ({}, testInfo) => {
    test.setTimeout(scaled(240_000));
    const caseId = 'cap-inherited';
    const skillName = 'inherited-capability-skill';
    const mcpServerId = 'inherited-capability-mcp';
    const mcpServerName = 'Inherited Capability MCP Server';
    const mcpToolName = 'inherited_probe';
    const evidence = `INHERITED_MCP_EVIDENCE_${caseId}`;
    let mcpFixture;
    let calledMcp = false;

    const { userDataDir, demo, fixture, electronApp, panel, composer, window } =
      await launchDelegationCase({
        testInfo,
        caseId,
        action: caseId,
        tabOverrides: {
          pluginSelections: {
            collectionIds: [],
            skillRefs: [{ sourceId: 'custom:app', skillName }],
            pluginRefs: [],
            mcpServerRefs: [{ serverId: mcpServerId, configId: 'default' }],
          },
        },
        setup: async (dir) => {
          seedCapabilitySkill({
            userDataDir: dir,
            skillName,
            description: 'Guidance the child inherits from the root chat.',
          });
          mcpFixture = await startCapabilityMcpFixture({
            toolName: mcpToolName,
            evidence,
          });
          seedCapabilityMcpServer({
            userDataDir: dir,
            serverId: mcpServerId,
            name: mcpServerName,
            origin: mcpFixture.origin,
          });
        },
        script: async (ctx) => {
          if (ctx.role === 'parent') return driveParentWatchFlow(ctx);
          if (ctx.role !== 'child') return undefined;
          if (!calledMcp) {
            const mcp = ctx.selectedMcpTool(mcpToolName);
            if (mcp) {
              calledMcp = true;
              return ctx.reply({ toolCalls: [mcp], stopReason: 'tool_use' });
            }
            if (ctx.harness === 'codex') {
              const search = ctx.codexMcpSearch(mcpToolName);
              if (search) return search;
            }
            throw new Error(
              `Inherited MCP tool "${mcpToolName}" was not offered to the child: ${JSON.stringify(ctx.item.toolNames)}`,
            );
          }
          return ctx.reply({
            text: ctx.results.includes(evidence)
              ? ctx.finding
              : `The inherited MCP tool call did not return evidence: ${ctx.results}`,
            stopReason: 'end_turn',
          });
        },
      });

    try {
      await sendDelegationRequest(
        composer,
        window,
        fixture,
        'Delegate an independent task that calls the inherited MCP tool and reports its evidence.',
      );
      await expect(
        panel.getByText(fixture.integrated, { exact: true }),
      ).toBeVisible({
        timeout: scaled(120_000),
      });

      // Would fail without the feature: before capability inheritance
      // existed, a plain child received no plugin/skill/MCP overlay at all,
      // so the inherited MCP tool would never appear in its offered tools
      // and this call could not happen.
      expect(mcpFixture.calls.length).toBeGreaterThan(0);
      const childRequestWithEvidence = fixture.requests.find(
        (request) =>
          request.role === 'child' && request.results.includes(evidence),
      );
      expect(childRequestWithEvidence).toBeTruthy();

      const delegated = await revealDelegatedAgent(panel);
      await delegated
        .getByRole('button', { name: 'Expand delegated task' })
        .click();
      const capabilitiesRow = delegated.getByTestId(
        'delegated-agent-capabilities',
      );
      await expect(capabilitiesRow).toBeVisible();
      // Would fail without the feature: with no capability grant recorded,
      // `hasDelegatedAgentCapabilityEntries` is false and this row never
      // renders at all (see `inherit-off` below for that exact case).
      await expect(capabilitiesRow).toContainText('Inherited 2');
      await delegated
        .getByTestId('delegated-agent-capabilities-toggle')
        .click();
      const inheritedGroup = delegated.getByTestId(
        'delegated-agent-capability-inherited',
      );
      await expect(inheritedGroup).toBeVisible();
      await expect(inheritedGroup).toContainText(skillName);
      await expect(inheritedGroup).toContainText('skill');
      await expect(inheritedGroup).toContainText(mcpServerName);
      await expect(inheritedGroup).toContainText('MCP server');

      const [run] = retainedDelegationRuns({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
      });
      expect(run?.capabilityGrant?.inherit).toBe(true);
      expect(run?.capabilityGrant?.summary?.items ?? []).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'skill', source: 'inherited' }),
          expect.objectContaining({ kind: 'mcp', source: 'inherited' }),
        ]),
      );

      await testInfo.attach('native-inference-requests', {
        body: JSON.stringify(
          { requests: fixture.requests, errors: fixture.errors },
          null,
          2,
        ),
        contentType: 'application/json',
      });
    } finally {
      await teardown({
        electronApp,
        userDataDir,
        demo,
        fixture,
        extraFixtures: [mcpFixture],
      });
    }
  });

  test('inherit-off: inherit_capabilities: false leaves a plain child with no inherited capabilities', async ({}, testInfo) => {
    test.setTimeout(scaled(240_000));
    const caseId = 'cap-inherit-off';
    const skillName = 'inherit-off-skill';
    const mcpServerId = 'inherit-off-mcp';
    const mcpServerName = 'Inherit Off MCP Server';
    const mcpToolName = 'inherit_off_probe';
    let mcpFixture;
    let spawned = false;

    const { userDataDir, demo, fixture, electronApp, panel, composer, window } =
      await launchDelegationCase({
        testInfo,
        caseId,
        action: caseId,
        tabOverrides: {
          pluginSelections: {
            collectionIds: [],
            skillRefs: [{ sourceId: 'custom:app', skillName }],
            pluginRefs: [],
            mcpServerRefs: [{ serverId: mcpServerId, configId: 'default' }],
          },
        },
        setup: async (dir) => {
          seedCapabilitySkill({
            userDataDir: dir,
            skillName,
            description: 'Guidance the child must NOT inherit in this case.',
          });
          mcpFixture = await startCapabilityMcpFixture({
            toolName: mcpToolName,
            evidence: `UNUSED_EVIDENCE_${caseId}`,
          });
          seedCapabilityMcpServer({
            userDataDir: dir,
            serverId: mcpServerId,
            name: mcpServerName,
            origin: mcpFixture.origin,
          });
        },
        script: async (ctx) => {
          if (ctx.role === 'parent') {
            // The provider can send side requests that carry the parent
            // marker but offer no tools; only the real turn can spawn.
            if (
              !spawned &&
              !ctx.results &&
              hasToolName(ctx.item.toolNames, ctx.spawnTool)
            ) {
              spawned = true;
              return ctx.reply({
                toolCalls: [
                  {
                    name: ctx.spawnTool,
                    input: { ...ctx.spawnInput, inherit_capabilities: false },
                  },
                ],
                stopReason: 'tool_use',
              });
            }
            return driveParentWatchFlow(ctx);
          }
          if (ctx.role === 'child')
            return ctx.reply({ text: ctx.finding, stopReason: 'end_turn' });
          return undefined;
        },
      });

    try {
      await sendDelegationRequest(
        composer,
        window,
        fixture,
        'Delegate an independent task without inheriting my capabilities.',
      );
      await expect(
        panel.getByText(fixture.integrated, { exact: true }),
      ).toBeVisible({
        timeout: scaled(120_000),
      });

      // Would fail without the feature: `inherit_capabilities` did not exist
      // before, so every spawn always inherited (the tool was never offered
      // to the child, unlike here where it must be entirely absent).
      const childRequest = fixture.requests.find(
        (request) => request.role === 'child',
      );
      expect(
        hasToolName(childRequest?.toolNames, claudeToolName(mcpToolName)),
      ).toBe(false);
      expect(
        (childRequest?.toolNames ?? []).some((name) =>
          name.endsWith(`.${mcpToolName}`),
        ),
      ).toBe(false);
      expect(mcpFixture.calls.length).toBe(0);

      const delegated = await revealDelegatedAgent(panel);
      await delegated
        .getByRole('button', { name: 'Expand delegated task' })
        .click();
      // Read the code: with inherit:false, no agent layer and no explicit
      // capabilities, `prepareDelegationCapabilities` materializes nothing,
      // so `summary.items`/`summary.skipped` are both empty and
      // `hasDelegatedAgentCapabilityEntries` is false — the whole
      // Capabilities row is absent, not merely showing zero counts.
      await expect(
        delegated.getByTestId('delegated-agent-capabilities'),
      ).toHaveCount(0);

      const [run] = retainedDelegationRuns({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
      });
      expect(run?.capabilityGrant?.inherit).toBe(false);
      expect(run?.capabilityGrant?.summary?.items ?? []).toEqual([]);

      await testInfo.attach('native-inference-requests', {
        body: JSON.stringify(
          { requests: fixture.requests, errors: fixture.errors },
          null,
          2,
        ),
        contentType: 'application/json',
      });
    } finally {
      await teardown({
        electronApp,
        userDataDir,
        demo,
        fixture,
        extraFixtures: [mcpFixture],
      });
    }
  });

  test('explicit-capabilities: capabilities assigns a catalog item discovered via List Delegates', async ({}, testInfo) => {
    test.setTimeout(scaled(240_000));
    const caseId = 'cap-explicit';
    const skillName = 'explicit-capability-skill';
    let listedCapabilities = false;
    let spawned = false;

    const { userDataDir, demo, fixture, electronApp, panel, composer, window } =
      await launchDelegationCase({
        testInfo,
        caseId,
        action: caseId,
        setup: (dir) =>
          seedCapabilitySkill({
            userDataDir: dir,
            skillName,
            description: 'Installed but not selected; assigned explicitly.',
          }),
        script: async (ctx) => {
          if (ctx.role === 'parent') {
            // The provider can send side requests that carry the parent
            // marker but offer no tools; only the real turn can list.
            if (
              !listedCapabilities &&
              !ctx.results &&
              hasToolName(
                ctx.item.toolNames,
                ctx.toolName('ListDelegates', 'list_delegates'),
              )
            ) {
              listedCapabilities = true;
              return ctx.reply({
                toolCalls: [
                  {
                    name: ctx.toolName('ListDelegates', 'list_delegates'),
                    input: { includeCapabilities: true },
                  },
                ],
                stopReason: 'tool_use',
              });
            }
            if (
              !spawned &&
              listedCapabilities &&
              hasToolName(ctx.item.toolNames, ctx.spawnTool)
            ) {
              const id = findListDelegatesCapabilityId(ctx.body, skillName);
              if (!id)
                throw new Error(
                  `Seeded skill "${skillName}" was not present in the List Delegates capability catalog: ${ctx.results}`,
                );
              spawned = true;
              return ctx.reply({
                toolCalls: [
                  {
                    name: ctx.spawnTool,
                    input: { ...ctx.spawnInput, capabilities: [id] },
                  },
                ],
                stopReason: 'tool_use',
              });
            }
            return driveParentWatchFlow(ctx);
          }
          if (ctx.role === 'child')
            return ctx.reply({ text: ctx.finding, stopReason: 'end_turn' });
          return undefined;
        },
      });

    try {
      await sendDelegationRequest(
        composer,
        window,
        fixture,
        'List delegate capabilities, then delegate an independent task assigned the installed skill.',
      );
      await expect(
        panel.getByText(fixture.integrated, { exact: true }),
      ).toBeVisible({
        timeout: scaled(120_000),
      });

      // Would fail without the feature: `capabilities` on the spawn schema
      // and `includeCapabilities` on List Delegates did not exist before, so
      // this exact tool-call sequence (and the resulting explicit grant)
      // could not be scripted or observed.
      expect(spawned).toBe(true);

      const delegated = await revealDelegatedAgent(panel);
      await delegated
        .getByRole('button', { name: 'Expand delegated task' })
        .click();
      const capabilitiesRow = delegated.getByTestId(
        'delegated-agent-capabilities',
      );
      await expect(capabilitiesRow).toBeVisible();
      await expect(capabilitiesRow).toContainText('Assigned 1');
      await delegated
        .getByTestId('delegated-agent-capabilities-toggle')
        .click();
      const explicitGroup = delegated.getByTestId(
        'delegated-agent-capability-explicit',
      );
      await expect(explicitGroup).toBeVisible();
      await expect(explicitGroup).toContainText(skillName);
      await expect(explicitGroup).toContainText('skill');

      const [run] = retainedDelegationRuns({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
      });
      expect(run?.capabilityGrant?.explicit?.length).toBe(1);
      expect(run?.capabilityGrant?.summary?.items ?? []).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'skill',
            source: 'explicit',
            name: skillName,
          }),
        ]),
      );

      await testInfo.attach('native-inference-requests', {
        body: JSON.stringify(
          { requests: fixture.requests, errors: fixture.errors },
          null,
          2,
        ),
        contentType: 'application/json',
      });
    } finally {
      await teardown({ electronApp, userDataDir, demo, fixture });
    }
  });

  test('child-deferred-denied: deferredToolsAllowed: false hides Search/Load Deferred Tools from the child', async ({}, testInfo) => {
    test.setTimeout(scaled(240_000));
    const caseId = 'cap-deferred-denied';

    const { userDataDir, demo, fixture, electronApp, panel, composer, window } =
      await launchDelegationCase({
        testInfo,
        caseId,
        action: caseId,
        tabOverrides: { deferredToolsAllowed: false },
        script: async (ctx) => {
          if (ctx.role === 'parent') return driveParentWatchFlow(ctx);
          if (ctx.role === 'child')
            return ctx.reply({ text: ctx.finding, stopReason: 'end_turn' });
          return undefined;
        },
      });

    try {
      await sendDelegationRequest(
        composer,
        window,
        fixture,
        'Delegate an independent task; no capability discovery is needed.',
      );
      await expect(
        panel.getByText(fixture.integrated, { exact: true }),
      ).toBeVisible({
        timeout: scaled(120_000),
      });

      const childRequest = fixture.requests.find(
        (request) => request.role === 'child',
      );
      const toolNames = childRequest?.toolNames ?? [];
      // Positive control: another app tool from the SAME `managed-delegate`
      // surface is present, so the absence of Search/Load below is not
      // vacuous (e.g. a surface entirely disabled would fail this too).
      expect(hasToolName(toolNames, claudeToolName('GetScriptOutput'))).toBe(
        true,
      );
      // Would fail without the feature: before the root chat's
      // `deferredToolsAllowed` gated a delegate's deferred-tools source,
      // Search/Load Deferred Tools were either always present or always
      // absent for a delegate, not conditioned on this tab setting.
      for (const name of [
        claudeToolName('SearchDeferredTools'),
        codexToolName('search_deferred_tools'),
        claudeToolName('LoadDeferredTools'),
        codexToolName('load_deferred_tools'),
      ])
        expect(hasToolName(toolNames, name)).toBe(false);

      await testInfo.attach('native-inference-requests', {
        body: JSON.stringify(
          { requests: fixture.requests, errors: fixture.errors },
          null,
          2,
        ),
        contentType: 'application/json',
      });
    } finally {
      await teardown({ electronApp, userDataDir, demo, fixture });
    }
  });

  // Both harnesses offer Search/Load Deferred Tools to a delegate, but their
  // in-run reload mechanics differ (see
  // `apps/desktop-app/src/main/agents/delegation/{claude-runner,codex-runner}.ts`):
  // Codex materializes a new native thread seeded from the retained history,
  // while Claude interrupts the turn once the Load result is delivered and
  // resumes the same session with a hidden continuation.
  for (const child of ['codex', 'claude']) {
    test(`child-deferred-load: a ${child} child searches, loads, and reloads capabilities in one run generation`, async ({}, testInfo) => {
      test.setTimeout(scaled(240_000));
      const caseId = `cap-deferred-load-${child}`;
      const skillName = `deferred-load-skill-${child}`;
      let searched = false;
      let loaded = false;

      const {
        userDataDir,
        demo,
        fixture,
        electronApp,
        panel,
        composer,
        window,
      } = await launchDelegationCase({
        testInfo,
        caseId,
        action: caseId,
        child,
        setup: (dir) =>
          seedCapabilitySkill({
            userDataDir: dir,
            skillName,
            description: 'Installed but not selected; loaded mid-run.',
          }),
        script: async (ctx) => {
          if (ctx.role === 'parent') return driveParentWatchFlow(ctx);
          if (ctx.role !== 'child') return undefined;
          if (!searched) {
            searched = true;
            return ctx.reply({
              toolCalls: [
                {
                  name: ctx.toolName(
                    'SearchDeferredTools',
                    'search_deferred_tools',
                  ),
                  input: { queries: [{ text: skillName, kinds: ['skill'] }] },
                },
              ],
              stopReason: 'tool_use',
            });
          }
          if (!loaded) {
            const ref = findDeferredSearchRef(ctx.body);
            if (!ref)
              throw new Error(
                `Seeded skill "${skillName}" was not found via Search Deferred Tools: ${ctx.results}`,
              );
            loaded = true;
            return ctx.reply({
              toolCalls: [
                {
                  name: ctx.toolName(
                    'LoadDeferredTools',
                    'load_deferred_tools',
                  ),
                  input: { items: [{ ref }] },
                },
              ],
              stopReason: 'tool_use',
            });
          }
          // Robust to however many intervening requests the reload takes: this
          // may answer either the interrupted turn or the resumed one; either
          // way the framework keeps only the resumed turn's outcome.
          return ctx.reply({ text: ctx.finding, stopReason: 'end_turn' });
        },
      });

      try {
        await sendDelegationRequest(
          composer,
          window,
          fixture,
          'Delegate an independent task that must search for and load a missing skill mid-run.',
        );
        await expect(
          panel.getByText(fixture.integrated, { exact: true }),
        ).toBeVisible({
          timeout: scaled(150_000),
        });

        const childRequest = fixture.requests.find(
          (request) => request.role === 'child',
        );
        const toolNames = childRequest?.toolNames ?? [];
        // Would fail without the feature: a delegate never offered Search
        // and Load Deferred Tools at all before capability discovery for
        // delegates existed.
        expect(
          hasToolName(
            toolNames,
            child === 'claude'
              ? claudeToolName('SearchDeferredTools')
              : codexToolName('search_deferred_tools'),
          ),
        ).toBe(true);
        expect(
          hasToolName(
            toolNames,
            child === 'claude'
              ? claudeToolName('LoadDeferredTools')
              : codexToolName('load_deferred_tools'),
          ),
        ).toBe(true);

        const delegated = await revealDelegatedAgent(panel);
        await delegated
          .getByRole('button', { name: 'Expand delegated task' })
          .click();
        const capabilitiesRow = delegated.getByTestId(
          'delegated-agent-capabilities',
        );
        await expect(capabilitiesRow).toBeVisible();
        await expect(capabilitiesRow).toContainText('Loaded 1');
        await delegated
          .getByTestId('delegated-agent-capabilities-toggle')
          .click();
        const loadedGroup = delegated.getByTestId(
          'delegated-agent-capability-loaded',
        );
        await expect(loadedGroup).toBeVisible();
        await expect(loadedGroup).toContainText(skillName);

        const [run] = retainedDelegationRuns({
          userDataDir,
          workspaceId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
        });
        expect(run?.capabilityGrant?.loaded?.length).toBe(1);
        // Would fail without the feature: before an in-run reload existed, a
        // mid-run capability change had no way to reach the SAME run
        // generation, and a naive implementation would either fail the Load
        // outright or start a brand-new run generation / second result.
        expect(run?.state?.runGeneration).toBe(1);
        expect(run?.results?.length).toBe(1);
        expect(run?.results?.[0]?.resultIndex).toBe(1);

        await testInfo.attach('native-inference-requests', {
          body: JSON.stringify(
            { requests: fixture.requests, errors: fixture.errors },
            null,
            2,
          ),
          contentType: 'application/json',
        });
      } finally {
        await teardown({ electronApp, userDataDir, demo, fixture });
      }
    });
  }

  // A delegate runs the tools on the user's login-shell PATH: Claude's Bash
  // always did; a Codex child's sandboxed shell now gets the same PATH, read
  // access to the tools on it, and a private TMPDIR. The probe lives in a
  // temporary PATH directory so the case does not depend on the host's
  // toolchains (macOS `path_helper` keeps inherited PATH entries).
  for (const child of ['codex', 'claude']) {
    test(`command-path: a ${child} child runs a tool from the login-shell PATH`, async ({}, testInfo) => {
      test.setTimeout(scaled(240_000));
      const caseId = `cap-command-path-${child}`;
      const marker = `DELEGATION_PATH_PROBE_${child.toUpperCase()}`;
      const probeDir = mkdtempSync(
        path.join(os.tmpdir(), 'delegation-path-probe-'),
      );
      writeFileSync(
        path.join(probeDir, 'delegation-path-probe'),
        `#!/bin/sh\necho ${marker}\n`,
        { mode: 0o755 },
      );
      const shellTool = child === 'claude' ? 'Bash' : 'exec_command';
      let ranProbe = false;

      const {
        userDataDir,
        demo,
        fixture,
        electronApp,
        panel,
        composer,
        window,
      } = await launchDelegationCase({
        testInfo,
        caseId,
        action: caseId,
        child,
        env: {
          PATH: `${probeDir}${path.delimiter}${process.env.PATH ?? ''}`,
        },
        script: async (ctx) => {
          if (ctx.role === 'parent') return driveParentWatchFlow(ctx);
          if (ctx.role !== 'child') return undefined;
          if (!ranProbe && hasToolName(ctx.item.toolNames, shellTool)) {
            ranProbe = true;
            return ctx.reply({
              toolCalls: [
                child === 'claude'
                  ? {
                      name: 'Bash',
                      input: { command: 'delegation-path-probe' },
                    }
                  : {
                      namespace: 'functions',
                      name: 'exec_command',
                      input: { cmd: 'delegation-path-probe', login: false },
                    },
              ],
              stopReason: 'tool_use',
            });
          }
          if (ranProbe && ctx.results)
            return ctx.reply({ text: ctx.finding, stopReason: 'end_turn' });
          return undefined;
        },
      });

      try {
        await sendDelegationRequest(
          composer,
          window,
          fixture,
          'Delegate a task that runs the path probe.',
        );
        await expect(
          panel.getByText(fixture.integrated, { exact: true }),
        ).toBeVisible({ timeout: scaled(180_000) });
        expect(ranProbe).toBe(true);
        // Would fail without the change for a Codex child: its command PATH
        // held only the validated Git directory and the system directories,
        // so the shell reported the probe as not found.
        const probeResult = fixture.requests.find(
          (request) =>
            request.role === 'child' &&
            (request.results ?? '').includes(marker),
        );
        expect(probeResult).toBeDefined();
        await testInfo.attach('native-inference-requests', {
          body: JSON.stringify(
            { requests: fixture.requests, errors: fixture.errors },
            null,
            2,
          ),
          contentType: 'application/json',
        });
      } finally {
        await teardown({ electronApp, userDataDir, demo, fixture });
        rmSync(probeDir, { recursive: true, force: true });
      }
    });
  }
});
