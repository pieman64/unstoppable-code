// Deterministic inference only. Provider binaries, application tools, file access,
// routing, persistence and native receipts all execute through production paths.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const delegationAgentSkillPath = `@agent/skills/${createHash('sha256').update('custom:app/delegated-review').digest('hex').slice(0, 16)}/skills/delegated-review/SKILL.md`;
import { Readable } from 'node:stream';
import { WebSocketServer } from 'ws';
import {
  handleLlmRequest,
  buildResponsesEvents,
  currentRequestTools,
} from './mock-server/routes/llm.mjs';
import { registerScenario } from './mock-server/control-plane.mjs';
import { handleAuthUsageRequest } from './mock-server/routes/authUsage.mjs';
import { loadBrand } from '../../../../scripts/brand/load-brand.mjs';

// Injected tool names derive from the built brand's namespace, such as
// `mcp__canopy__DelegateTask` or `unstoppable-code_spawn_delegate`. The E2E
// build and this fixture read the same `CANOPY_BRAND`.
export const TOOL_NAMESPACE = loadBrand(process.env.CANOPY_BRAND || 'canopy')
  .tools.namespace;
export const claudeToolName = (name) => `mcp__${TOOL_NAMESPACE}__${name}`;
export const codexToolName = (name) => `${TOOL_NAMESPACE}_${name}`;

// Codex code mode offers nested tools in the exec gateway's declarations.
// Observe declarations, never prose examples or tool descriptions mentioning
// a forbidden tool: confinement assertions must inspect what is offered.
function offeredToolNames(tools) {
  return (tools ?? []).flatMap((candidate) => {
    if (candidate.type !== 'namespace')
      return [candidate.name ?? candidate.type];
    return (candidate.tools ?? []).flatMap((nested) => {
      const name = `${candidate.name}.${nested.name}`;
      if (candidate.name !== 'functions' || nested.name !== 'exec')
        return [name];
      const declared = [
        ...(nested.description ?? '').matchAll(
          /declare const tools: \{\s*([A-Za-z_$][\w$]*)\(/g,
        ),
      ].map((match) => `functions.${match[1]}`);
      return [name, ...declared];
    });
  });
}

function userText(body) {
  return (body.messages ?? body.input ?? [])
    .filter((item) => item.role === 'user')
    .map((item) => JSON.stringify(item.content))
    .join('\n');
}
function lastUserText(body) {
  const last = (body.messages ?? body.input ?? [])
    .filter((item) => item.role === 'user')
    .at(-1);
  return JSON.stringify(last?.content ?? '');
}
function toolResultEntries(body) {
  const results = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if (value.type === 'tool_result')
      results.push(JSON.stringify(value.content));
    if (
      value.type === 'function_call_output' ||
      value.type === 'custom_tool_call_output'
    )
      results.push(JSON.stringify(value.output));
    for (const item of Object.values(value))
      if (typeof item === 'object') visit(item);
  };
  visit(body.messages ?? body.input);
  return results;
}
function toolResults(body) {
  return toolResultEntries(body).join('\n');
}
// Yields every string in a captured request body, decoding strings that carry
// nested JSON. Matching decoded strings instead of JSON-stringified bodies keeps
// Windows paths intact: JSON escapes their backslash separators.
function* stringLeaves(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        yield* stringLeaves(JSON.parse(trimmed));
        return;
      } catch {
        // Not JSON; fall through to the raw string.
      }
    }
    yield value;
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const item of Object.values(value)) yield* stringLeaves(item);
}
function matchStringLeaves(value, pattern) {
  return Array.from(stringLeaves(value)).flatMap((text) =>
    Array.from(text.matchAll(pattern), (match) => match[1]),
  );
}
// Claude Code 2.1.310 offers MCP tools as deferred tools (loaded through
// ToolSearch): their names are listed in a reminder, not in `tools`.
const DEFERRED_TOOLS_HEADER = 'before calling them:\n';
function claudeDeferredToolNames(body) {
  return Array.from(stringLeaves(body)).flatMap((text) => {
    const start = text.indexOf(DEFERRED_TOOLS_HEADER);
    if (start < 0) return [];
    return text
      .slice(start + DEFERRED_TOOLS_HEADER.length)
      .split('\n\n')[0]
      .split('\n');
  });
}

export async function createDelegationInference({
  parent,
  child,
  mode,
  caseId,
  onRequest,
  policy,
  action,
  // Optional per-spec inference script. Called for every captured request
  // before the built-in state machine; return `ctx.reply(step)` (or
  // `{ marker, step }` / `{ marker, failure: true }`) to answer, or undefined
  // to fall through. Lets new specs script a case in their own file.
  script,
}) {
  const parentMarker = `Canopy-CDELEGATIONPARENT-${caseId}`;
  const childMarker = `Canopy-CDELEGATIONCHILD-${caseId}`;
  const grandchildMarker = `Canopy-CDELEGATIONGRANDCHILD-${caseId}`;
  const nestedFinding = `NESTED_EVIDENCE_${caseId}`;
  const canary = `READ_BOUNDARY_EVIDENCE_${caseId}`;
  const privateCanary = `PRIVATE_BOUNDARY_EVIDENCE_${caseId}`;
  const partial = `Partial read-only finding for ${caseId}`;
  const finding = `Validated the read-only source for ${caseId}`;
  const integrated = `Integrated the delegated finding for ${caseId}`;
  const continued = `Continuing independent parent work for ${caseId}`;
  const coldFollowUp = `Answered after a cold restart for ${caseId}`;
  // request-steering: the child's message to its root chat, and the root's
  // reply once that message reaches it.
  const steeringRequest = `DELEGATE_STEERING_REQUEST_${caseId}`;
  const steeringReply = `Answered the delegate steering request for ${caseId}`;
  const requests = [];
  const errors = [];
  let sequence = 0;
  // Claude's Bash tool runs POSIX Git Bash on Windows too. Codex exec_command
  // runs PowerShell there, where `cat` is Get-Content and a single quote inside
  // a single-quoted string is escaped by doubling it.
  const nativeRead = (harness, file) =>
    harness === 'claude'
      ? ['command-approval', 'nested-approval', 'nested-cancel'].includes(
          action,
        )
        ? {
            name: 'Bash',
            input: { command: `cat '${file.replaceAll("'", "'\\''")}'` },
          }
        : { name: 'Read', input: { file_path: file } }
      : {
          namespace: 'functions',
          name: 'exec_command',
          input: {
            cmd:
              process.platform === 'win32'
                ? `cat '${file.replaceAll("'", "''")}'`
                : `cat '${file.replaceAll("'", "'\\''")}'`,
          },
        };
  let nestedResumeRead = false;
  let nestedResumeLaunched = false;
  let nestedResumeTargetId;
  let nestedResumeNotices = 0;
  let nestedGrantResumeLaunched = false;
  let nestedFollowUpLaunched = false;
  let nestedDepthResumeLaunched = false;
  let nestedDepthResumeTargetId;
  let nestedDepthResumeNotices = 0;
  let continuationApprovalStep = 0;
  // isolation-conflict: apply fails on a parent edit, the delegate reconciles,
  // then a second apply succeeds. The spec inspects the parent between them.
  let conflictStep = 0;
  let attemptedReconcileEdit = false;
  let releaseConflictRetry;
  const conflictRetryBarrier =
    action === 'isolation-conflict'
      ? new Promise((resolve) => {
          releaseConflictRetry = resolve;
        })
      : Promise.resolve();
  // request-steering-queued: the parent's call after its spawn waits for
  // releaseParentTurn, so the root turn is still running.
  let releaseParentTurn;
  const parentTurnBarrier =
    action === 'request-steering-queued'
      ? new Promise((resolve) => {
          releaseParentTurn = resolve;
        })
      : Promise.resolve();
  let releaseContinuation;
  const continuationBarrier =
    action === 'continuation-approval'
      ? new Promise((resolve) => {
          releaseContinuation = resolve;
        })
      : Promise.resolve();
  let attemptedCommandApproval = false;
  // policy-change: a command after the parent leaves Full Access.
  let attemptedPolicyDowngradeCommand = false;
  // background-task: detached shell, managed background task, output read.
  let attemptedDetachedShell = false;
  let attemptedBackgroundTask = false;
  let attemptedBackgroundRead = false;
  let attemptedBackgroundEvidence = false;
  let attemptedNativeGrant = false;
  let attemptedNativeEdit = false;
  let attemptedNativeWrite = false;
  let attemptedStandaloneSkill = false;
  let attemptedPluginSkill = false;
  let attemptedCodexSkillList = false;
  let attemptedCodexStandaloneRead = false;
  let attemptedCodexPluginRead = false;
  let attemptedAgentFollowUpRead = false;
  let attemptedAgentFollowUpMcpCall = false;
  let attemptedDeniedMcpProbe = false;
  let attemptedParentAmbientSearch = false;
  let attemptedSelectedMcpCall = false;
  let attemptedPluginMcpCall = false;
  const attemptedCodexMcpSearches = new Set();
  let releaseChild;
  let releaseParentInitialization;
  const parentInitializationBarrier =
    action === 'initialization-cancel'
      ? new Promise((resolve) => {
          releaseParentInitialization = resolve;
        })
      : Promise.resolve();
  let armNextDelegation = false;
  let firstSessionReuseDelegationId;
  let childRead;
  const childReadBarrier = new Promise((resolve) => {
    childRead = resolve;
  });
  const childBarrier =
    mode === 'background' ||
    ['cancel', 'long-running', 'async'].includes(action)
      ? new Promise((resolve) => {
          releaseChild = resolve;
        })
      : Promise.resolve();
  // Cancellation owns a child turn, not the shared Codex app-server process.
  // Observe its real inference transport after the native evidence read. The
  // response stays held at childBarrier, so closing it proves interruption.
  const childConnections = [];
  function trackChildCancellation(body, transport) {
    if (
      action !== 'cancel' ||
      !userText(body).includes(childMarker) ||
      !toolResults(body).includes(canary)
    )
      return;
    const connection = { closed: false };
    childConnections.push(connection);
    transport.once('close', () => {
      connection.closed = true;
    });
  }
  const brief = {
    'claude/claude':
      'Perform an adversarial review of the error handling and report one concrete failure mode.',
    'claude/codex':
      'Give a root-cause second opinion for a missing error cause and identify the responsible branch.',
    'codex/claude':
      'Suggest an architecture alternative for preserving errors, with one specific tradeoff.',
    'codex/codex':
      'Scan for a test gap in the error path and describe the missing assertion.',
  }[`${parent}/${child}`];
  const prompt = `[${childMarker}] Read delegation-evidence.txt. ${brief} ${['write', 'write-approval', 'isolation', 'isolation-conflict', 'shell-append'].includes(action) ? 'Edit the explicitly granted file after reading it.' : 'Scope: inspection only, no modifications.'} Return one finding with the source path.`;
  const tool =
    parent === 'claude'
      ? claudeToolName('DelegateTask')
      : codexToolName('spawn_delegate');
  const model = ['agent', 'agent-capabilities', 'agent-follow-up'].includes(
    action,
  )
    ? 'agent_model_delegated_reviewer'
    : child === 'claude'
      ? 'sonnet'
      : 'gpt-6.1-sol';
  const spawnInput =
    parent === 'claude'
      ? {
          model,
          description: 'Independent error handling review',
          prompt,
          run_in_background: mode === 'background',
          thinking_level: 'high',
        }
      : {
          model,
          task_name: 'independent_review',
          message: prompt,
          execution_mode: mode,
          reasoning_effort: 'high',
        };

  if (action === 'grant-deny') spawnInput.permissions = { writePaths: ['.'] };

  if (action === 'nested-grant-attenuation')
    spawnInput.permissions = { writePaths: ['workspace/narrow'] };

  if (action?.startsWith('nested')) spawnInput.allow_nested_delegation = true;

  if (action === 'fast') spawnInput.fast_mode = true;

  if (
    [
      'write',
      'write-approval',
      'isolation',
      'isolation-conflict',
      'shell-append',
    ].includes(action)
  )
    spawnInput.permissions = { writePaths: ['delegation-evidence.txt'] };

  if (
    [
      'isolation',
      'isolation-conflict',
      'git-history-isolated',
      'nested-resume',
    ].includes(action)
  )
    spawnInput.isolation = 'worktree';

  function selectedMcpTool(body, toolName) {
    for (const candidate of body.tools ?? []) {
      if (candidate.type === 'namespace') {
        const nested = candidate.tools?.find((tool) => tool.name === toolName);
        if (nested)
          return { namespace: candidate.name, name: nested.name, input: {} };
      }
      if (
        (candidate.name ?? '').startsWith('mcp__') &&
        candidate.name.endsWith(`__${toolName}`)
      )
        return { name: candidate.name, input: {} };
    }
    for (const output of body.input ?? []) {
      if (output.type !== 'tool_search_output') continue;
      for (const candidate of output.tools ?? []) {
        if (candidate.type === 'namespace') {
          const nested = candidate.tools?.find(
            (tool) => tool.name === toolName,
          );
          if (nested)
            return { namespace: candidate.name, name: nested.name, input: {} };
        }
        const fullName = candidate.name ?? '';
        if (
          !fullName.startsWith('mcp__') ||
          !fullName.endsWith(`__${toolName}`)
        )
          continue;
        const separator = fullName.lastIndexOf('__');
        return {
          namespace: fullName.slice(0, separator),
          name: fullName.slice(separator + 2),
          input: {},
        };
      }
    }
    return null;
  }

  function retainedRoots(value) {
    // The root ends at the sentence's period; paths may contain dots or
    // spaces (Windows profile directories) and either separator.
    return matchStringLeaves(
      value,
      /Retained Agent files are available at (.+?)\.(?=\s|$)/g,
    ).filter((root) => /[\\/]delegated-agent-files-/.test(root));
  }

  function retainedAgentSkillFile(body) {
    const currentRoots = [
      ...retainedRoots(body.system),
      ...retainedRoots(body.instructions),
    ];
    const historyRoots = retainedRoots(body.messages ?? body.input);
    const root = currentRoots.at(-1) ?? historyRoots.at(-1);
    return path.join(root, delegationAgentSkillPath.slice(7));
  }

  function codexMcpSearch(body, toolName) {
    if (
      attemptedCodexMcpSearches.has(toolName) ||
      !(body.tools ?? []).some((candidate) => candidate.type === 'tool_search')
    )
      return null;
    attemptedCodexMcpSearches.add(toolName);
    return {
      marker: childMarker,
      step: {
        toolSearch: { query: toolName, limit: 10 },
        stopReason: 'tool_use',
      },
    };
  }

  function nativeNamespaceTool(body, namespace, name, input) {
    const available = (body.tools ?? []).some(
      (candidate) =>
        candidate.type === 'namespace' &&
        candidate.name === namespace &&
        candidate.tools?.some((nested) => nested.name === name),
    );
    return available ? { namespace, name, input } : null;
  }

  function findSkillDescriptor(value, name) {
    if (
      typeof value === 'string' &&
      (value.trim().startsWith('[') || value.trim().startsWith('{'))
    ) {
      try {
        return findSkillDescriptor(JSON.parse(value), name);
      } catch {
        return null;
      }
    }
    if (!value || typeof value !== 'object') return null;
    if (
      (value.name === name || value.name?.endsWith(`:${name}`)) &&
      typeof value.package === 'string' &&
      /[\\/]codex-capabilities[\\/]v1[\\/]roots[\\/]/.test(value.package)
    )
      return value;
    for (const child of Object.values(value)) {
      const found = findSkillDescriptor(child, name);
      if (found) return found;
    }
    return null;
  }

  async function select(body, harness) {
    body = { ...body, tools: currentRequestTools(body) };
    const text = userText(body);
    const results = toolResults(body);
    // A delegate completion notice wakes the parent like a fired watcher.
    const notified =
      text.includes('watcher fired') || /delegate finished/i.test(text);
    // Earlier notices stay in the history, so a resumed run counts as notified
    // only once a notice arrives after the resume. A batched notice from before
    // it can land first, so each new notice fetches the output again.
    const notices =
      text.match(/watcher fired|delegate finished/gi)?.length ?? 0;
    const context = JSON.stringify(body.messages ?? body.input ?? []);
    const isGrandchild = text.includes(grandchildMarker);
    const isChild = !isGrandchild && text.includes(childMarker);
    const isParent = text.includes(parentMarker) || text.includes(finding);
    const hasPriorIntegrated = (
      JSON.stringify(body.messages ?? body.input) ?? ''
    ).includes(integrated);
    const item = {
      harness,
      role: isGrandchild
        ? 'grandchild'
        : isChild
          ? 'child'
          : isParent
            ? 'parent'
            : 'helper',
      model: body.model,
      serviceTier: body.service_tier,
      tools: body.tools,
      hasAgentInstructions: JSON.stringify(body).includes(
        'RETAINED_AGENT_REVIEW_INSTRUCTIONS',
      ),
      hasSelectedMcpTool: Boolean(selectedMcpTool(body, 'review_evidence')),
      hasSelectedPluginMcpTool: Boolean(selectedMcpTool(body, 'plugin_review')),
      hasNativeSkillTool: (body.tools ?? []).some(
        (tool) => tool.name === 'Skill',
      ),
      hasCodexSkillListTool: Boolean(
        nativeNamespaceTool(body, 'skills', 'list', {}),
      ),
      hasCodexSkillReadTool: Boolean(
        nativeNamespaceTool(body, 'skills', 'read', {}),
      ),
      hasAmbientSkillCatalog: results.includes('ambient-review'),
      hasAmbientSkillContext: context.includes('ambient-review'),
      hasStandaloneSkillResult: results.includes(
        'Retain the original error cause.',
      ),
      hasPluginSkillResult: results.includes(`PLUGIN_SKILL_EVIDENCE_${caseId}`),
      hasStandaloneSkillContext: context.includes(
        'Retain the original error cause.',
      ),
      hasPluginSkillContext: context.includes(
        `PLUGIN_SKILL_EVIDENCE_${caseId}`,
      ),
      hasStandaloneSkillLaunch: results.includes(
        'Launching skill: delegated-review:delegated-review',
      ),
      hasPluginSkillLaunch: results.includes(
        'Launching skill: delegated-review-plugin:plugin-review',
      ),
      hasDeniedMcpResult:
        /denied|declined|not allowed|permission/i.test(results) &&
        results.includes('denied_probe'),
      hasAmbientMcpTool:
        JSON.stringify(body.tools ?? []).includes('ambient_probe') ||
        Boolean(selectedMcpTool(body, 'ambient_probe')) ||
        claudeDeferredToolNames(body).some((name) =>
          name.endsWith('__ambient_probe'),
        ),
      hasGitCommandInstructions: JSON.stringify(body).includes(
        'Use exec_command with login:false',
      ),
      // Repository CLAUDE.md / AGENTS.md content reaching the request.
      hasProjectInstructions: JSON.stringify(body).includes(
        `PROJECT_INSTRUCTIONS_${caseId}`,
      ),
      hasSetupHint: JSON.stringify(body).includes('Isolated worktree setup'),
      hasSetupCommand: JSON.stringify(body).includes('pnpm install'),
      // A fired watcher's hidden context reached this request.
      hasWatcherEvent: JSON.stringify(body).includes('_watcher_event>'),
      // A delegate completion notice, or a command watcher's event, reached it.
      // Payload fields, not tool descriptions that name the same values.
      hasDelegateNotice: /kind\\*":\s*\\*"delegation_finished/.test(
        JSON.stringify(body),
      ),
      hasCommandWatcherEvent: /trigger\\*":\s*\\*"command_watch_resolved/.test(
        JSON.stringify(body),
      ),
      results,
      hasNativeEvidence: results.includes(canary),
      hasWorkspaceObservation:
        results.includes('workspaceObservation') ||
        text.includes('workspaceObservation'),
      hasPriorIntegrated,
      ...(action === 'agent-follow-up' && isChild
        ? {
            systemRoots: retainedRoots(body.system),
            instructionRoots: retainedRoots(body.instructions),
            historyRoots: retainedRoots(body.messages ?? body.input),
            chosenSkillFile: retainedAgentSkillFile(body),
          }
        : {}),
      // Flattened offered tool names; namespaced Codex tools as `ns.name`.
      toolNames: offeredToolNames(body.tools),
      // What each Codex tool search returned, in the same `ns.name` form. A
      // selected MCP tool the child cannot find is missing from these too.
      toolSearchResults: (body.input ?? [])
        .filter((entry) => entry.type === 'tool_search_output')
        .map((entry) =>
          (entry.tools ?? []).flatMap((candidate) =>
            candidate.type === 'namespace'
              ? (candidate.tools ?? []).map(
                  (nested) => `${candidate.name}.${nested.name}`,
                )
              : [candidate.name ?? candidate.type],
          ),
        ),
      receivedAt: Date.now(),
    };
    if (
      item.toolNames.some((name) =>
        /WatchDelegates$|watch_delegates$/.test(name),
      )
    )
      throw new Error('Fresh provider tools must not advertise WatchDelegates');
    requests.push(item);
    onRequest?.(requests);
    if (isParent && action === 'initialization-cancel')
      await parentInitializationBarrier;
    if (script) {
      const roleMarker = isGrandchild
        ? grandchildMarker
        : isChild
          ? childMarker
          : isParent
            ? parentMarker
            : undefined;
      const scripted = await script({
        role: item.role,
        item,
        body,
        harness,
        text,
        results,
        context,
        resultEntries: toolResultEntries(body),
        markers: {
          parent: parentMarker,
          child: childMarker,
          grandchild: grandchildMarker,
        },
        caseId,
        canary,
        finding,
        integrated,
        continued,
        prompt,
        spawnInput,
        spawnTool: tool,
        toolName: (claude, codex) =>
          harness === 'claude' ? claudeToolName(claude) : codexToolName(codex),
        nativeRead: (file) => nativeRead(harness, file),
        selectedMcpTool: (name) => selectedMcpTool(body, name),
        codexMcpSearch: (name) => codexMcpSearch(body, name),
        childRead,
        childBarrier,
        requests,
        reply: (step) => ({ marker: roleMarker, step }),
      });
      if (scripted) return scripted;
    }
    if (
      isGrandchild &&
      action === 'nested-follow-up' &&
      text.includes('NESTED_CHILD_FOLLOW_UP')
    )
      return {
        marker: grandchildMarker,
        step: {
          text: `FOLLOWED_UP_${nestedFinding}`,
          stopReason: 'end_turn',
        },
      };
    if (
      isGrandchild &&
      action === 'nested-resume' &&
      text.includes('NESTED_FOLLOW_UP')
    ) {
      if (!nestedResumeRead) {
        nestedResumeRead = true;
        return {
          marker: grandchildMarker,
          step: {
            toolCalls: [nativeRead(harness, 'nested-location.txt')],
            stopReason: 'tool_use',
          },
        };
      }
      if (!results.includes(`NESTED_ISOLATED_${caseId}`))
        throw new Error('Resumed grandchild lost its inherited workspace');
      return {
        marker: grandchildMarker,
        step: { text: `RESUMED_${nestedFinding}`, stopReason: 'end_turn' },
      };
    }
    if (
      isChild &&
      action === 'nested-depth-lowered' &&
      text.includes('NESTED_DEPTH_LOWERED_FOLLOW_UP')
    )
      return {
        marker: childMarker,
        step: {
          text: `${finding} DEPTH_LOWERED_${caseId}`,
          stopReason: 'end_turn',
        },
      };
    if (
      isParent &&
      action === 'nested-depth-lowered' &&
      ((nestedDepthResumeLaunched && nestedDepthResumeTargetId) ||
        text.includes('NESTED_DEPTH_LOWERED_RESUME') ||
        text.includes(`DEPTH_LOWERED_${caseId}`))
    ) {
      if (
        nestedDepthResumeLaunched &&
        results.includes(`DEPTH_LOWERED_${caseId}`)
      )
        return {
          marker: parentMarker,
          step: { text: `${integrated} resumed`, stopReason: 'end_turn' },
        };
      if (!nestedDepthResumeLaunched) {
        nestedDepthResumeLaunched = true;
        nestedDepthResumeNotices = notices;
        const id = text.match(
          /NESTED_DEPTH_LOWERED_RESUME ([0-9a-f-]{36})/,
        )?.[1];
        if (!id) throw new Error('Missing root-selected nested child');
        nestedDepthResumeTargetId = id;
        return {
          marker: parentMarker,
          step: {
            toolCalls: [
              {
                name:
                  harness === 'claude'
                    ? claudeToolName('MessageDelegate')
                    : codexToolName('message_delegate'),
                input: {
                  delegationId: id,
                  operation: 'follow_up',
                  message: `[${childMarker}] NESTED_DEPTH_LOWERED_FOLLOW_UP Report the retained finding without delegating.`,
                },
              },
            ],
            stopReason: 'tool_use',
          },
        };
      }

      if (notices > nestedDepthResumeNotices) {
        nestedDepthResumeNotices = notices;
        return {
          marker: parentMarker,
          step: {
            toolCalls: [
              {
                name:
                  harness === 'claude'
                    ? claudeToolName('GetDelegateOutput')
                    : codexToolName('get_delegate_output'),
                input: { delegationId: nestedDepthResumeTargetId },
              },
            ],
            stopReason: 'tool_use',
          },
        };
      }
      return {
        marker: parentMarker,
        step: {
          text: 'Waiting for the resumed nested child.',
          stopReason: 'end_turn',
        },
      };
    }
    if (
      isParent &&
      action === 'nested-resume' &&
      ((nestedResumeLaunched && nestedResumeTargetId) ||
        text.includes('NESTED_ROOT_RESUME'))
    ) {
      if (nestedResumeLaunched && results.includes(`RESUMED_${nestedFinding}`))
        return {
          marker: parentMarker,
          step: { text: `${integrated} resumed`, stopReason: 'end_turn' },
        };
      if (!nestedResumeLaunched) {
        nestedResumeLaunched = true;
        nestedResumeNotices = notices;
        const id = text.match(/NESTED_ROOT_RESUME ([0-9a-f-]{36})/)?.[1];
        if (!id) throw new Error('Missing root-selected grandchild');
        nestedResumeTargetId = id;
        return {
          marker: parentMarker,
          step: {
            toolCalls: [
              {
                name:
                  harness === 'claude'
                    ? claudeToolName('MessageDelegate')
                    : codexToolName('message_delegate'),
                input: {
                  delegationId: id,
                  operation: 'follow_up',
                  message: `[${grandchildMarker}] NESTED_FOLLOW_UP Read nested-location.txt in your original working directory.`,
                },
              },
            ],
            stopReason: 'tool_use',
          },
        };
      }

      if (notices > nestedResumeNotices) {
        nestedResumeNotices = notices;
        return {
          marker: parentMarker,
          step: {
            toolCalls: [
              {
                name:
                  harness === 'claude'
                    ? claudeToolName('GetDelegateOutput')
                    : codexToolName('get_delegate_output'),
                input: { delegationId: nestedResumeTargetId },
              },
            ],
            stopReason: 'tool_use',
          },
        };
      }
      return {
        marker: parentMarker,
        step: {
          text: 'Waiting for the resumed grandchild.',
          stopReason: 'end_turn',
        },
      };
    }
    if (
      isParent &&
      action === 'nested-grant-attenuation' &&
      text.includes('NESTED_ROOT_WIDEN')
    ) {
      if (!nestedGrantResumeLaunched) {
        nestedGrantResumeLaunched = true;
        const id = text.match(/NESTED_ROOT_WIDEN ([0-9a-f-]{36})/)?.[1];
        if (!id) throw new Error('Missing root-selected grandchild');
        return {
          marker: parentMarker,
          step: {
            toolCalls: [
              {
                name:
                  harness === 'claude'
                    ? claudeToolName('MessageDelegate')
                    : codexToolName('message_delegate'),
                input: {
                  delegationId: id,
                  operation: 'follow_up',
                  message: `[${grandchildMarker}] Attempt widened grant resume.`,
                  permissions: { writePaths: ['workspace/wide'] },
                },
              },
            ],
            stopReason: 'tool_use',
          },
        };
      }
      if (!results.includes('policy_blocked'))
        throw new Error(`Root-issued resume widened nested grants: ${results}`);
      return {
        marker: parentMarker,
        step: { text: `${integrated} attenuated`, stopReason: 'end_turn' },
      };
    }
    if (isGrandchild) {
      if (!results)
        return {
          marker: grandchildMarker,
          step: {
            toolCalls: [nativeRead(harness, 'delegation-evidence.txt')],
            stopReason: 'tool_use',
          },
        };
      if (!results.includes(canary))
        throw new Error('Grandchild did not read the evidence');
      childRead();
      await childBarrier;
      return {
        marker: grandchildMarker,
        step: { text: nestedFinding, stopReason: 'end_turn' },
      };
    }
    if (isChild && action?.startsWith('nested')) {
      if (
        action === 'nested-follow-up' &&
        text.includes(`FOLLOWED_UP_${nestedFinding}`)
      )
        return {
          marker: childMarker,
          step: { text: finding, stopReason: 'end_turn' },
        };
      if (text.includes(nestedFinding))
        return {
          marker: childMarker,
          step: {
            text:
              action === 'nested-follow-up'
                ? 'Waiting for the nested follow-up.'
                : finding,
            stopReason: 'end_turn',
          },
        };
      if (
        action === 'nested-follow-up' &&
        results.includes('delegationId') &&
        !nestedFollowUpLaunched
      ) {
        nestedFollowUpLaunched = true;
        const id = results.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0];
        if (!id) throw new Error('Missing nested child delegation identity');
        return {
          marker: childMarker,
          step: {
            toolCalls: [
              {
                name:
                  harness === 'claude'
                    ? claudeToolName('MessageDelegate')
                    : codexToolName('message_delegate'),
                input: {
                  delegationId: id,
                  operation: 'follow_up',
                  message: `[${grandchildMarker}] NESTED_CHILD_FOLLOW_UP Confirm the retained finding.`,
                },
              },
            ],
            stopReason: 'tool_use',
          },
        };
      }
      if (results.includes('delegationId'))
        return {
          marker: childMarker,
          step: {
            text: 'Waiting for my delegated review.',
            stopReason: 'end_turn',
          },
        };
      if (results) throw new Error(`Nested delegation failed: ${results}`);
      const nestedPrompt = `[${grandchildMarker}] Read delegation-evidence.txt and report evidence.`;
      const nestedInput =
        harness === 'claude'
          ? {
              model: parent === 'claude' ? 'sonnet' : 'gpt-6.1-sol',
              description: 'Nested evidence review',
              prompt: nestedPrompt,
              allow_nested_delegation: true,
            }
          : {
              model: parent === 'claude' ? 'sonnet' : 'gpt-6.1-sol',
              task_name: 'nested_evidence_review',
              message: nestedPrompt,
              allow_nested_delegation: true,
            };
      if (action === 'nested-grant-attenuation')
        nestedInput.permissions = {
          writePaths: ['workspace/narrow/file.ts'],
        };
      return {
        marker: childMarker,
        step: {
          toolCalls: [
            {
              name:
                harness === 'claude'
                  ? claudeToolName('DelegateTask')
                  : codexToolName('spawn_delegate'),
              input: nestedInput,
            },
          ],
          stopReason: 'tool_use',
        },
      };
    }
    if (isChild) {
      // request-steering: once the test releases it, the child asks its root
      // chat for steering, then finishes. While its request is queued the
      // child stays live until the root turn is released, so the test can
      // read the waiting state before the delegate finishes.
      if (action?.startsWith('request-steering')) {
        if (results) {
          await parentTurnBarrier;
          return {
            marker: childMarker,
            step: { text: finding, stopReason: 'end_turn' },
          };
        }
        await childBarrier;
        return {
          marker: childMarker,
          step: {
            toolCalls: [
              {
                name:
                  harness === 'claude'
                    ? claudeToolName('RequestSteering')
                    : codexToolName('request_steering'),
                input: { message: steeringRequest },
              },
            ],
            stopReason: 'tool_use',
          },
        };
      }
      // background-task: shell detachment is refused with guidance, and a
      // CLI-managed background task runs with a readable output file.
      if (action === 'background-task' && harness === 'claude') {
        // Read the evidence file first, as every confined child does.
        if (!attemptedBackgroundEvidence) {
          attemptedBackgroundEvidence = true;
          return {
            marker: childMarker,
            step: {
              toolCalls: [nativeRead(harness, 'delegation-evidence.txt')],
              stopReason: 'tool_use',
            },
          };
        }
        if (!attemptedDetachedShell) {
          attemptedDetachedShell = true;
          return {
            marker: childMarker,
            step: {
              toolCalls: [
                {
                  name: 'Bash',
                  input: {
                    // No leading `sleep`: Claude Code 2.1.310 blocks that
                    // itself, before the delegation policy sees the command.
                    command: `nohup true & echo DETACHED_${caseId}`,
                    description: 'Detached attempt',
                  },
                },
              ],
              stopReason: 'tool_use',
            },
          };
        }
        if (!attemptedBackgroundTask) {
          attemptedBackgroundTask = true;
          return {
            marker: childMarker,
            step: {
              toolCalls: [
                {
                  name: 'Bash',
                  input: {
                    command: `printf '%s\\n' BACKGROUND_OUTPUT_${caseId}`,
                    run_in_background: true,
                    description: 'Managed background task',
                  },
                },
              ],
              stopReason: 'tool_use',
            },
          };
        }
        const outputFile = results.match(
          /Output is being written to: (\S+?\.output)/,
        )?.[1];
        if (outputFile && !attemptedBackgroundRead) {
          attemptedBackgroundRead = true;
          return {
            marker: childMarker,
            step: {
              toolCalls: [{ name: 'Read', input: { file_path: outputFile } }],
              stopReason: 'tool_use',
            },
          };
        }
        // Like every background child, finish only once the test releases it,
        // so the parent can observe the run while it is still running.
        await childBarrier;
        return {
          marker: childMarker,
          step: {
            text: results.includes(`BACKGROUND_OUTPUT_${caseId}`)
              ? finding
              : 'The background task output was unavailable.',
            stopReason: 'end_turn',
          },
        };
      }
      // The child registers a command watch in its own working directory and
      // ends its run; the fired watcher later resumes the child, not the parent.
      if (action === 'delegate-watch') {
        if (
          JSON.stringify(body.messages ?? body.input ?? []).includes(
            '_watcher_event>',
          )
        )
          return {
            marker: childMarker,
            step: {
              text: `WATCHER_DELIVERED_${caseId}`,
              stopReason: 'end_turn',
            },
          };
        if (results.includes('Watcher registered'))
          return {
            marker: childMarker,
            step: { text: finding, stopReason: 'end_turn' },
          };
        if (results)
          return {
            marker: childMarker,
            step: {
              text: `Watcher registration failed: ${results}`,
              stopReason: 'end_turn',
            },
          };
        return {
          marker: childMarker,
          step: {
            toolCalls: [
              {
                name:
                  harness === 'claude'
                    ? 'mcp__canopy__WatchCommand'
                    : 'canopy_watch_command',
                input: {
                  command: 'test -f delegate-watch-ready.txt',
                  intervalSeconds: 5,
                  maxAttempts: 60,
                  followUpInstruction: `Report WATCHER_DELIVERED_${caseId}.`,
                },
              },
            ],
            stopReason: 'tool_use',
          },
        };
      }
      if (
        action === 'agent-follow-up' &&
        text.includes('DELEGATION_FOLLOW_UP')
      ) {
        if (!attemptedAgentFollowUpRead) {
          attemptedAgentFollowUpRead = true;
          return {
            marker: childMarker,
            step: {
              toolCalls: [nativeRead(harness, retainedAgentSkillFile(body))],
              stopReason: 'tool_use',
            },
          };
        }
        if (
          !(toolResultEntries(body).at(-1) ?? '').includes(canary) &&
          !attemptedAgentFollowUpMcpCall
        )
          return {
            marker: childMarker,
            step: {
              text: 'The retained Agent skill was unavailable on follow-up.',
              stopReason: 'end_turn',
            },
          };
        if (!attemptedAgentFollowUpMcpCall) {
          const mcp = selectedMcpTool(body, 'review_evidence');
          if (!mcp && harness === 'codex') {
            const search = codexMcpSearch(body, 'review_evidence');
            if (search) return search;
          }
          if (!mcp)
            return {
              marker: childMarker,
              step: {
                text: 'The retained Agent MCP tool was unavailable on follow-up.',
                stopReason: 'end_turn',
              },
            };
          attemptedAgentFollowUpMcpCall = true;
          return {
            marker: childMarker,
            step: { toolCalls: [mcp], stopReason: 'tool_use' },
          };
        }
        return {
          marker: childMarker,
          step: {
            text: results.includes(`MCP_REVIEW_EVIDENCE_${caseId}`)
              ? `FOLLOW_UP_RETAINED_${caseId}`
              : 'The retained Agent MCP call failed on follow-up.',
            stopReason: 'end_turn',
          },
        };
      }
      if (action === 'agent-capabilities') {
        if (harness === 'claude' && !attemptedStandaloneSkill) {
          attemptedStandaloneSkill = true;
          if (!(body.tools ?? []).some((tool) => tool.name === 'Skill'))
            return {
              marker: childMarker,
              step: {
                text: 'The selected Agent skill was not registered.',
                stopReason: 'end_turn',
              },
            };
          return {
            marker: childMarker,
            step: {
              toolCalls: [
                {
                  name: 'Skill',
                  input: { skill: 'delegated-review:delegated-review' },
                },
              ],
              stopReason: 'tool_use',
            },
          };
        }
        if (harness === 'claude' && !attemptedPluginSkill) {
          attemptedPluginSkill = true;
          return {
            marker: childMarker,
            step: {
              toolCalls: [
                {
                  name: 'Skill',
                  input: { skill: 'delegated-review-plugin:plugin-review' },
                },
              ],
              stopReason: 'tool_use',
            },
          };
        }
        if (harness === 'codex' && !attemptedCodexSkillList) {
          attemptedCodexSkillList = true;
          const tool = nativeNamespaceTool(body, 'skills', 'list', {
            authority: { kind: 'executor' },
          });
          return {
            marker: childMarker,
            step: tool
              ? { toolCalls: [tool], stopReason: 'tool_use' }
              : {
                  text: 'The native Codex skill catalog was unavailable.',
                  stopReason: 'end_turn',
                },
          };
        }
        if (harness === 'codex' && !attemptedCodexStandaloneRead) {
          attemptedCodexStandaloneRead = true;
          const descriptor = findSkillDescriptor(
            body.input,
            'delegated-review',
          );
          const tool =
            descriptor &&
            nativeNamespaceTool(body, 'skills', 'read', {
              package: descriptor.package,
            });
          return {
            marker: childMarker,
            step: tool
              ? { toolCalls: [tool], stopReason: 'tool_use' }
              : {
                  text: 'The selected Agent skill was absent from the native Codex catalog.',
                  stopReason: 'end_turn',
                },
          };
        }
        if (harness === 'codex' && !attemptedCodexPluginRead) {
          attemptedCodexPluginRead = true;
          const descriptor = findSkillDescriptor(body.input, 'plugin-review');
          const tool =
            descriptor &&
            nativeNamespaceTool(body, 'skills', 'read', {
              package: descriptor.package,
            });
          return {
            marker: childMarker,
            step: tool
              ? { toolCalls: [tool], stopReason: 'tool_use' }
              : {
                  text: 'The selected plugin skill was absent from the native Codex catalog.',
                  stopReason: 'end_turn',
                },
          };
        }
        if (
          !(harness === 'claude'
            ? results.includes(
                'Launching skill: delegated-review:delegated-review',
              ) && context.includes('Retain the original error cause.')
            : results.includes('Retain the original error cause.'))
        )
          return {
            marker: childMarker,
            step: {
              text: 'The selected Agent skill did not load through the native provider.',
              stopReason: 'end_turn',
            },
          };
        if (
          !(harness === 'claude'
            ? results.includes(
                'Launching skill: delegated-review-plugin:plugin-review',
              ) && context.includes(`PLUGIN_SKILL_EVIDENCE_${caseId}`)
            : results.includes(`PLUGIN_SKILL_EVIDENCE_${caseId}`))
        )
          return {
            marker: childMarker,
            step: {
              text: 'The selected plugin skill did not load through the native provider.',
              stopReason: 'end_turn',
            },
          };
        if (!results.includes('export async function loadSource'))
          return {
            marker: childMarker,
            step: {
              toolCalls: [nativeRead(harness, 'delegation-evidence.txt')],
              stopReason: 'tool_use',
            },
          };
        if (!results.includes(`MCP_REVIEW_EVIDENCE_${caseId}`)) {
          if (attemptedSelectedMcpCall)
            return {
              marker: childMarker,
              step: {
                text: `The configured review_evidence MCP call failed: ${toolResultEntries(body).at(-1) ?? ''}`,
                stopReason: 'end_turn',
              },
            };
          const mcp = selectedMcpTool(body, 'review_evidence');
          if (!mcp && harness === 'codex') {
            const search = codexMcpSearch(body, 'review_evidence');
            if (search) return search;
          }
          if (!mcp)
            return {
              marker: childMarker,
              step: {
                text: 'The configured review_evidence MCP tool was unavailable.',
                stopReason: 'end_turn',
              },
            };
          attemptedSelectedMcpCall = true;
          return {
            marker: childMarker,
            step: { toolCalls: [mcp], stopReason: 'tool_use' },
          };
        }
        if (!results.includes(`PLUGIN_REVIEW_EVIDENCE_${caseId}`)) {
          if (attemptedPluginMcpCall)
            return {
              marker: childMarker,
              step: {
                text: `The configured plugin_review MCP call failed: ${toolResultEntries(body).at(-1) ?? ''}`,
                stopReason: 'end_turn',
              },
            };
          const mcp = selectedMcpTool(body, 'plugin_review');
          if (!mcp && harness === 'codex') {
            const search = codexMcpSearch(body, 'plugin_review');
            if (search) return search;
          }
          if (!mcp)
            return {
              marker: childMarker,
              step: {
                text: 'The configured plugin_review MCP tool was unavailable.',
                stopReason: 'end_turn',
              },
            };
          attemptedPluginMcpCall = true;
          return {
            marker: childMarker,
            step: { toolCalls: [mcp], stopReason: 'tool_use' },
          };
        }
        if (!attemptedDeniedMcpProbe) {
          const mcp = selectedMcpTool(body, 'denied_probe');
          if (!mcp && harness === 'codex') {
            const search = codexMcpSearch(body, 'denied_probe');
            if (search) return search;
          }
          attemptedDeniedMcpProbe = true;
          if (!mcp)
            return {
              marker: childMarker,
              step: {
                text: 'The selected denied_probe tool was unavailable.',
                stopReason: 'end_turn',
              },
            };
          return {
            marker: childMarker,
            step: { toolCalls: [mcp], stopReason: 'tool_use' },
          };
        }
        return {
          marker: childMarker,
          step: { text: finding, stopReason: 'end_turn' },
        };
      }
      if (
        action?.startsWith('resume') &&
        text.includes('DELEGATION_FOLLOW_UP')
      ) {
        if (action === 'resume-native-write' && !attemptedNativeWrite) {
          attemptedNativeWrite = true;
          return {
            marker: childMarker,
            step: {
              toolCalls: [
                {
                  name: 'apply_patch',
                  input:
                    '*** Begin Patch\n*** Add File: unauthorized-native.txt\n+UNGRANTED_NATIVE_WRITE\n*** End Patch',
                },
              ],
              stopReason: 'tool_use',
            },
          };
        }
        if (!results.includes(`RESUMED_${canary}`))
          return {
            marker: childMarker,
            step: {
              toolCalls: [
                {
                  ...nativeRead(harness, 'delegation-follow-up.txt'),
                },
              ],
              stopReason: 'tool_use',
            },
          };
        return {
          marker: childMarker,
          step: {
            text: `${finding} RESUMED_${canary}`,
            stopReason: 'end_turn',
          },
        };
      }
      if (
        harness === 'codex' &&
        [
          'write',
          'write-approval',
          'isolation',
          'isolation-conflict',
          'grant-deny',
        ].includes(action) &&
        results.includes(canary) &&
        !attemptedNativeGrant
      ) {
        attemptedNativeGrant = true;
        // Codex children read "Shell commands and file edits may write only
        // within: …"; older builds said "…edits are permitted only within: …".
        const [grantedPath] = matchStringLeaves(
          body,
          /(?:[Ee]dits are permitted only|may write only) within: (.+?)\. Parent approvals apply/g,
        );
        if (!grantedPath)
          throw new Error(
            'Expected native write grant in captured task instructions',
          );
        return {
          marker: childMarker,
          step: {
            toolCalls: [
              {
                name: 'request_permissions',
                input: {
                  permissions: { file_system: { write: [grantedPath] } },
                  reason: 'Apply the explicitly requested child edit.',
                },
              },
            ],
            stopReason: 'tool_use',
          },
        };
      }
      // shell-append deliberately skips the request_permissions turn grant
      // above: the task's write grant alone must let the sandbox accept it.
      if (
        [
          'write',
          'write-approval',
          'isolation',
          'isolation-conflict',
          'grant-deny',
          'shell-append',
        ].includes(action) &&
        results.includes(canary) &&
        !attemptedNativeEdit
      ) {
        attemptedNativeEdit = true;
        return {
          marker: childMarker,
          step: {
            toolCalls: [
              harness === 'claude'
                ? {
                    name: 'Write',
                    input: {
                      file_path: 'delegation-evidence.txt',
                      content: `// ${canary}\n// Explicit child edit\n`,
                    },
                  }
                : {
                    // POSIX-only: phase 10 must supply a PowerShell equivalent
                    // before delegated Codex children run on Windows.
                    namespace: 'functions',
                    name: 'exec_command',
                    input: {
                      cmd:
                        action === 'shell-append'
                          ? `printf '%s\\n' '// Explicit child edit' >> delegation-evidence.txt`
                          : `printf '%s\\n' '// ${canary}' '// Explicit child edit' > delegation-evidence.txt`,
                    },
                  },
            ],
            stopReason: 'tool_use',
          },
        };
      }
      if (
        action === 'isolation-conflict' &&
        text.includes('DELEGATION_RECONCILE')
      ) {
        if (!attemptedReconcileEdit) {
          attemptedReconcileEdit = true;
          // Keep the parent's reported line alongside the delegate's edit.
          return {
            marker: childMarker,
            step: {
              toolCalls: [
                {
                  name: 'Write',
                  input: {
                    file_path: 'delegation-evidence.txt',
                    content: `// ${canary}\n// Explicit child edit\n// Parent edit\n`,
                  },
                },
              ],
              stopReason: 'tool_use',
            },
          };
        }
        return {
          marker: childMarker,
          step: { text: finding, stopReason: 'end_turn' },
        };
      }
      if (
        ['command-approval', 'command-native-rules'].includes(action) &&
        results.includes(canary) &&
        !attemptedCommandApproval
      ) {
        attemptedCommandApproval = true;
        // Claude's Bash tool runs Git Bash on Windows, where /bin/echo exists.
        // The Codex command is POSIX-only: phase 10 must supply a PowerShell
        // equivalent (and matching native rule) for Windows Codex children.
        return {
          marker: childMarker,
          step: {
            toolCalls: [
              {
                name: harness === 'claude' ? 'Bash' : 'exec_command',
                input:
                  harness === 'claude'
                    ? { command: '/bin/echo DENIED_COMMAND_CANARY' }
                    : { cmd: '/bin/echo DENIED_COMMAND_CANARY', login: false },
              },
            ],
            stopReason: 'tool_use',
          },
        };
      }
      if (results) {
        childRead();
        if (action === 'partial-failure')
          return { marker: childMarker, failure: true };
        await childBarrier;
        // Released after the parent left Full Access: run one command that
        // mode would have allowed, so the live Ask mode must prompt for it.
        if (action === 'policy-change' && !attemptedPolicyDowngradeCommand) {
          attemptedPolicyDowngradeCommand = true;
          return {
            marker: childMarker,
            step: {
              toolCalls: [
                {
                  name: harness === 'claude' ? 'Bash' : 'exec_command',
                  input:
                    harness === 'claude'
                      ? { command: '/bin/echo POLICY_DOWNGRADE_CANARY' }
                      : {
                          cmd: '/bin/echo POLICY_DOWNGRADE_CANARY',
                          login: false,
                        },
                },
              ],
              stopReason: 'tool_use',
            },
          };
        }
        return {
          marker: childMarker,
          step: {
            text: (
              policy
                ? !results.includes(privateCanary) &&
                  /denied|disabled|no such tool|unavailable|not available|unsupported|not found|unknown|invalid|not allowed|not permitted|no matches found/i.test(
                    results,
                  )
                : results.includes(canary)
            )
              ? finding
              : 'The confined read did not return the requested evidence',
            stopReason: 'end_turn',
          },
        };
      }
      if (policy === 'native-child' || policy === 'managed-child')
        return {
          marker: childMarker,
          step: {
            toolCalls: [
              {
                ...(harness === 'codex' && policy === 'native-child'
                  ? { namespace: 'functions' }
                  : {}),
                name:
                  policy === 'native-child'
                    ? harness === 'claude'
                      ? 'Agent'
                      : 'spawn_agent'
                    : harness === 'claude'
                      ? claudeToolName('DelegateTask')
                      : codexToolName('spawn_delegate'),
                input:
                  harness === 'claude'
                    ? {
                        model: 'sonnet',
                        description: 'Recursive probe',
                        prompt: 'Read .env',
                        subagent_type: 'general-purpose',
                      }
                    : {
                        model: 'gpt-6.1-sol',
                        task_name: 'recursive_probe',
                        message: 'Read .env',
                      },
              },
            ],
            stopReason: 'tool_use',
          },
        };
      return {
        marker: childMarker,
        step: {
          ...(action === 'partial-failure' ? { text: partial } : {}),
          // Claude's Bash tool runs these POSIX scripts through Git Bash on
          // Windows. The Codex-only exec_command fixtures (git history,
          // git/file writes) are POSIX-only: phase 10 must supply PowerShell
          // equivalents before delegated Codex children run on Windows.
          toolCalls: [
            action?.startsWith('git-history')
              ? {
                  ...(harness === 'codex' ? { namespace: 'functions' } : {}),
                  name: harness === 'claude' ? 'Bash' : 'exec_command',
                  input: {
                    ...(harness === 'codex' ? { login: false } : {}),
                    [harness === 'claude' ? 'command' : 'cmd']:
                      'git log -1 --format=%s && git branch --list && git shortlog -sn HEAD && git status --porcelain && git config --get delegation.fixture && git config --worktree --get delegation.worktreeFixture && common_git_dir="$(git rev-parse --git-common-dir)" && if cat "$common_git_dir"/worktrees/*/config.worktree 2>/dev/null; then echo SIBLING_METADATA_EXPOSED; else echo SIBLING_METADATA_DENIED; fi',
                  },
                }
              : policy === 'native-nested-git'
                ? {
                    namespace: 'functions',
                    name: 'exec_command',
                    input: { cmd: 'cat nested/.git/private', login: false },
                  }
                : policy === 'native-git-write' ||
                    policy === 'native-file-write'
                  ? {
                      namespace: 'functions',
                      name: 'exec_command',
                      input: {
                        login: false,
                        cmd:
                          policy === 'native-git-write'
                            ? 'git branch readonly-boundary-probe; git config delegation.forbidden WRITE_DENIED'
                            : 'touch forbidden-shell-write.txt',
                      },
                    }
                  : policy === 'native-exec'
                    ? {
                        ...(harness === 'codex'
                          ? { namespace: 'functions' }
                          : {}),
                        name: harness === 'claude' ? 'Bash' : 'exec_command',
                        input:
                          harness === 'claude'
                            ? { command: 'cat .env' }
                            : { cmd: 'cat .env' },
                      }
                    : policy === 'native-search'
                      ? {
                          name: 'Grep',
                          input: {
                            path: '.',
                            pattern: 'PRIVATE_BOUNDARY_EVIDENCE',
                            glob: 'credentials',
                            output_mode: 'content',
                          },
                        }
                      : policy === 'native-read'
                        ? { name: 'Read', input: { file_path: '.env' } }
                        : policy === 'skill-read'
                          ? {
                              namespace: 'skills',
                              name: 'read',
                              input: { package: '../.env' },
                            }
                          : policy === 'question'
                            ? {
                                name: 'request_user_input',
                                input: {
                                  questions: [
                                    {
                                      id: 'probe',
                                      header: 'Probe',
                                      question: 'Harmless delegated question',
                                      options: [
                                        {
                                          label: 'One',
                                          description: 'First',
                                        },
                                        {
                                          label: 'Two',
                                          description: 'Second',
                                        },
                                      ],
                                    },
                                  ],
                                },
                              }
                            : {
                                ...nativeRead(
                                  harness,
                                  [
                                    'agent',
                                    'agent-capabilities',
                                    'agent-follow-up',
                                  ].includes(action)
                                    ? retainedAgentSkillFile(body)
                                    : 'delegation-evidence.txt',
                                ),
                              },
          ],
          stopReason: 'tool_use',
        },
      };
    }
    if (isParent) {
      if (action?.startsWith('request-steering')) {
        if (lastUserText(body).includes(steeringRequest))
          return {
            marker: parentMarker,
            step: { text: steeringReply, stopReason: 'end_turn' },
          };
        if (results.includes('delegationId')) await parentTurnBarrier;
      }
      if (
        action === 'partial-failure' &&
        text.includes('FAILURE_OUTPUT_PROBE') &&
        !results.includes('Deterministic child failure')
      ) {
        const delegationId = text.match(
          /FAILURE_OUTPUT_PROBE ([0-9a-f-]{36})/,
        )?.[1];
        if (!delegationId) throw new Error('Missing failed child ID');
        return {
          marker: parentMarker,
          step: {
            toolCalls: [
              {
                name:
                  harness === 'claude'
                    ? claudeToolName('GetDelegateOutput')
                    : codexToolName('get_delegate_output'),
                input: { delegationId, resultIndex: 1 },
              },
            ],
            stopReason: 'tool_use',
          },
        };
      }

      if (text.includes('COLD_RESTART_FOLLOW_UP'))
        return {
          marker: parentMarker,
          step: { text: coldFollowUp, stopReason: 'end_turn' },
        };
      if (action === 'model-change' && text.includes('MODEL_SWITCH_PROBE'))
        return {
          marker: parentMarker,
          step: { text: 'Selected model observed.', stopReason: 'end_turn' },
        };
      if (
        action === 'agent-capabilities' &&
        harness === 'codex' &&
        (body.tools ?? []).some(
          (candidate) => candidate.type === 'tool_search',
        ) &&
        !attemptedParentAmbientSearch
      ) {
        attemptedParentAmbientSearch = true;
        return {
          marker: parentMarker,
          step: {
            toolSearch: { query: 'ambient_probe', limit: 5 },
            stopReason: 'tool_use',
          },
        };
      }
      if (
        action === 'agent-follow-up' &&
        text.includes('AGENT_RETENTION_FOLLOW_UP')
      ) {
        if (results.includes('operationId'))
          return {
            marker: parentMarker,
            step: {
              text: 'Retained Agent follow-up requested.',
              stopReason: 'end_turn',
            },
          };
        const delegationId = text.match(
          /delegationId ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
        )?.[1];
        if (!delegationId)
          throw new Error('Missing retained Agent delegation ID');
        return {
          marker: parentMarker,
          step: {
            toolCalls: [
              {
                name:
                  harness === 'claude'
                    ? claudeToolName('MessageDelegate')
                    : codexToolName('message_delegate'),
                input: {
                  delegationId,
                  operation: 'follow_up',
                  message: `[${childMarker}] DELEGATION_FOLLOW_UP Read the retained Agent skill and report its original evidence.`,
                },
              },
            ],
            stopReason: 'tool_use',
          },
        };
      }
      if (
        action === 'session-reuse' &&
        armNextDelegation &&
        text.includes('Delegate the same independent review again')
      ) {
        const resultIds = [
          ...results.matchAll(
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
          ),
        ].map(([id]) => id);
        if (!resultIds.some((id) => id !== firstSessionReuseDelegationId))
          return {
            marker: parentMarker,
            step: {
              toolCalls: [
                {
                  name: tool,
                  input: {
                    ...spawnInput,
                    [harness === 'claude' ? 'prompt' : 'message']:
                      `${prompt} This is a new review requested in a later turn.`,
                  },
                },
              ],
              stopReason: 'tool_use',
            },
          };
        armNextDelegation = false;
      }
      if (
        action === 'discovery' &&
        !results.includes('supportedThinkingLevels') &&
        !results.includes('delegationId')
      )
        return {
          marker: parentMarker,
          step: {
            toolCalls: [
              {
                name:
                  harness === 'claude'
                    ? claudeToolName('ListDelegates')
                    : codexToolName('list_delegates'),
                input: { includeModels: true },
              },
            ],
            stopReason: 'tool_use',
          },
        };
      // Conversation turns only. Codex carries developer instructions in the
      // same input list, and the managed-delegation steering names these
      // tools, so it must not read as a call that already happened.
      const history = JSON.stringify(
        (body.messages ?? body.input ?? []).filter(
          (item) => item?.role !== 'developer' && item?.role !== 'system',
        ),
      );
      if (
        ['cancel', 'nested-cancel'].includes(action) &&
        results.includes('delegationId')
      )
        await childBarrier;
      if (action === 'restraint')
        return {
          marker: parentMarker,
          step: { text: integrated, stopReason: 'end_turn' },
        };
      if (action === 'stop' && results.includes('stopRequested'))
        return {
          marker: parentMarker,
          step: { text: integrated, stopReason: 'end_turn' },
        };
      const needsWatcher =
        action === 'watch' ||
        action === 'isolation' ||
        action === 'isolation-conflict' ||
        action === 'continuation-approval' ||
        action?.startsWith('resume');
      if (
        results.includes('delegationId') &&
        (needsWatcher || action === 'stop')
      ) {
        const id = results.match(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
        )?.[0];
        if (!id)
          throw new Error('Native spawn response omitted its delegation ID');
        const hostName = (claude, codex) =>
          harness === 'claude' ? claudeToolName(claude) : codexToolName(codex);
        const list = hostName('ListDelegates', 'list_delegates');
        const inspect = hostName('InspectDelegate', 'inspect_delegate');
        const watch = hostName('WatchDelegates', 'watch_delegates');
        const output = hostName('GetDelegateOutput', 'get_delegate_output');
        const stop = hostName('StopDelegate', 'stop_delegate');
        if (action === 'stop' && !history.includes(stop)) {
          await childReadBarrier;
          return {
            marker: parentMarker,
            step: {
              toolCalls: [{ name: stop, input: { delegationId: id } }],
              stopReason: 'tool_use',
            },
          };
        }
        if (action === 'watch') {
          const next = !history.includes(list)
            ? { name: list, input: {} }
            : !history.includes(inspect)
              ? { name: inspect, input: { delegationId: id } }
              : !history.includes(watch)
                ? {
                    name: watch,
                    input: {
                      delegationIds: [id],
                      mode: 'all',
                      // Explicit unlisted compatibility injection, not a fresh offer.
                      timeoutMs: 1_800_000,
                    },
                  }
                : !history.includes(output) ||
                    (notified && !results.includes(finding))
                  ? { name: output, input: { delegationId: id } }
                  : undefined;
          if (next)
            return {
              marker: parentMarker,
              step: { toolCalls: [next], stopReason: 'tool_use' },
            };
        }
        if (needsWatcher && action !== 'watch') {
          const next =
            notified && !results.includes(finding)
              ? { name: output, input: { delegationId: id } }
              : undefined;
          if (next)
            return {
              marker: parentMarker,
              step: { toolCalls: [next], stopReason: 'tool_use' },
            };
        }
      }
      if (
        action === 'isolation' &&
        history.includes(finding) &&
        !results.includes('operationId')
      ) {
        const id = (text + results).match(
          /delegationId[^0-9a-f]{0,10}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
        )?.[1];
        return {
          marker: parentMarker,
          step: {
            toolCalls: [
              {
                name:
                  harness === 'claude'
                    ? claudeToolName('ManageDelegateWorktree')
                    : codexToolName('manage_delegate_worktree'),
                input: { delegationId: id, operation: 'apply' },
              },
            ],
            stopReason: 'tool_use',
          },
        };
      }
      if (action === 'isolation-conflict' && history.includes(finding)) {
        const id = (text + results).match(
          /delegationId[^0-9a-f]{0,10}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
        )?.[1];
        if (!id) throw new Error('Missing child ID for the isolated apply');
        const hostName = (claude, codex) =>
          harness === 'claude' ? `mcp__canopy__${claude}` : `canopy_${codex}`;
        const call = (name, input) => ({
          marker: parentMarker,
          step: { toolCalls: [{ name, input }], stopReason: 'tool_use' },
        });
        const apply = () =>
          call(hostName('ManageDelegateWorktree', 'manage_delegate_worktree'), {
            delegationId: id,
            operation: 'apply',
          });
        if (conflictStep === 0) {
          conflictStep = 1;
          return apply();
        }
        if (conflictStep === 1) {
          if (!results.includes('apply_failed'))
            throw new Error(
              'The first isolated apply did not report a conflict',
            );
          await conflictRetryBarrier;
          conflictStep = 2;
          return call(hostName('MessageDelegate', 'message_delegate'), {
            delegationId: id,
            operation: 'follow_up',
            message: `[${childMarker}] DELEGATION_RECONCILE The parent changed delegation-evidence.txt after you copied it (it added "// Parent edit"). Keep that line with your edit, then report.`,
          });
        }
        if (conflictStep === 2) {
          if (
            (text.match(/watcher fired|delegate finished/gi)?.length ?? 0) < 2
          )
            return {
              marker: parentMarker,
              step: {
                text: 'Waiting for the delegate to reconcile.',
                stopReason: 'end_turn',
              },
            };
          conflictStep = 4;
          return apply();
        }
      }
      if (
        action?.startsWith('resume') &&
        history.includes(finding) &&
        !history.includes(`RESUMED_${canary}`)
      ) {
        if (results.includes('parent_unavailable'))
          throw new Error('The delegated follow-up was rejected.');
        if (!results.includes('operationId')) {
          const id = (text + results).match(
            /delegationId[^0-9a-f]{0,10}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
          )?.[1];
          if (!id) throw new Error('Missing child ID for continuation');
          return {
            marker: parentMarker,
            step: {
              toolCalls: [
                {
                  name:
                    harness === 'claude'
                      ? claudeToolName('MessageDelegate')
                      : codexToolName('message_delegate'),
                  input: {
                    delegationId: id,
                    operation: 'follow_up',
                    message: `[${childMarker}] DELEGATION_FOLLOW_UP Read delegation-follow-up.txt and report the fresh evidence.`,
                  },
                },
              ],
              stopReason: 'tool_use',
            },
          };
        }
        const id = (text + results).match(
          /delegationId[^0-9a-f]{0,10}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
        )?.[1];
        if (!id) throw new Error('Missing child ID for continuation notice');

        if ((text.match(/watcher fired|delegate finished/gi)?.length ?? 0) >= 2)
          return {
            marker: parentMarker,
            step: {
              toolCalls: [
                {
                  name:
                    harness === 'claude'
                      ? claudeToolName('GetDelegateOutput')
                      : codexToolName('get_delegate_output'),
                  input: { delegationId: id },
                },
              ],
              stopReason: 'tool_use',
            },
          };
        return {
          marker: parentMarker,
          step: {
            text: 'Accepted the child follow-up.',
            stopReason: 'end_turn',
          },
        };
      }
      if (
        action === 'continuation-approval' &&
        JSON.stringify(body.messages ?? body.input).includes(finding) &&
        body.tools?.some((tool) =>
          [
            claudeToolName('GetScriptOutput'),
            codexToolName('get_script_output'),
          ].includes(tool.name),
        )
      ) {
        if (continuationApprovalStep < 2) {
          const step = ++continuationApprovalStep;
          return {
            marker: parentMarker,
            step: {
              toolCalls: [
                harness === 'claude'
                  ? {
                      name: claudeToolName('GetScriptOutput'),
                      input: { scriptId: `approval-timer-${step}` },
                    }
                  : {
                      name: 'apply_patch',
                      input: `*** Begin Patch\n*** Add File: approval-timer-${step}.txt\n+Approval timer regression\n*** End Patch`,
                    },
              ],
              stopReason: 'tool_use',
            },
          };
        }
        await continuationBarrier;
      }
      if (JSON.stringify(body.messages ?? body.input).includes(finding))
        return {
          marker: parentMarker,
          step: { text: integrated, stopReason: 'end_turn' },
        };
      if (results.includes('delegationId'))
        return {
          marker: parentMarker,
          step: { text: continued, stopReason: 'end_turn' },
        };
      if (
        results &&
        !(action === 'discovery' && results.includes('supportedThinkingLevels'))
      )
        return {
          marker: parentMarker,
          step: {
            text: `Delegation failed: ${results}`,
            stopReason: 'end_turn',
          },
        };
      return {
        marker: parentMarker,
        step: {
          toolCalls: Array.from(
            { length: action?.startsWith('capacity') ? 6 : 1 },
            () => ({ name: tool, input: spawnInput }),
          ),
          stopReason: 'tool_use',
        },
      };
    }
    return {
      marker: undefined,
      step: { text: 'Background helper completed', stopReason: 'end_turn' },
    };
  }
  async function responseEvents(body) {
    const { step, failure } = await select(body, 'codex');
    if (failure)
      return [
        {
          event: 'response.failed',
          data: {
            type: 'response.failed',
            response: {
              id: `resp_failed_${++sequence}`,
              status: 'failed',
              error: {
                code: 'invalid_request',
                message: 'Deterministic child failure after partial output',
              },
            },
          },
        },
      ];
    const suffix = `_${++sequence}`;
    return buildResponsesEvents(
      step,
      { inputTokens: 42, outputTokens: 12 },
      body.model ?? 'gpt-6.1-sol',
    ).map((event) => ({
      ...event,
      data: JSON.parse(
        JSON.stringify(event.data, (_key, value) =>
          value?.type === 'function_call' && value.name === 'apply_patch'
            ? {
                id: value.id,
                type: 'custom_tool_call',
                name: value.name,
                call_id: value.call_id,
                input: JSON.parse(value.arguments),
              }
            : typeof value === 'string' && /^(call_mock_|fc_mock_)/.test(value)
              ? value + suffix
              : value,
        ),
      ),
    }));
  }
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (handleAuthUsageRequest(request, response, requestUrl)) return;
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (
        url.pathname.endsWith('/responses') ||
        url.pathname.endsWith('/messages')
      )
        trackChildCancellation(body, response);
      if (url.pathname.endsWith('/responses')) {
        const events = await responseEvents(body);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of events)
          response.write(
            `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
          );
        response.end();
        return;
      }
      if (url.pathname.endsWith('/messages/count_tokens')) {
        const replay = Readable.from([Buffer.from(JSON.stringify(body))]);
        replay.headers = request.headers;
        replay.method = request.method;
        replay.url = request.url;
        await handleLlmRequest(replay, response, url);
        return;
      }
      const { marker, step, failure } = await select(body, 'claude');
      if (failure) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'Deterministic child failure after partial output',
            },
          }),
        );
        return;
      }
      if (marker) registerScenario(marker, { llm: { steps: [step] } });
      const replay = Readable.from([Buffer.from(JSON.stringify(body))]);
      replay.headers = request.headers;
      replay.method = request.method;
      replay.url = request.url;
      const suffix = `_${++sequence}`;
      const rewrite = (value) =>
        typeof value === 'string'
          ? value.replace(/"toolu_mock_(\d+)"/g, `"toolu_mock_$1${suffix}"`)
          : value;
      const write = response.write.bind(response);
      const end = response.end.bind(response);
      response.write = (value, ...args) => write(rewrite(value), ...args);
      response.end = (value, ...args) => end(rewrite(value), ...args);
      if (!(await handleLlmRequest(replay, response, url)))
        response.writeHead(404).end();
    })().catch((error) => {
      errors.push(String(error));
      response.destroy();
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on('error', () => undefined);
      ws.on('message', (data) => {
        void (async () => {
          const body = JSON.parse(data.toString());
          trackChildCancellation(body, ws);
          for (const event of await responseEvents(body))
            if (ws.readyState === 1) ws.send(JSON.stringify(event.data));
        })().catch((error) => {
          errors.push(String(error));
          ws.close();
        });
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    parentMarker,
    canary,
    brief,
    privateCanary,
    finding,
    partial,
    integrated,
    continued,
    coldFollowUp,
    steeringRequest,
    steeringReply,
    requests,
    childConnections,
    errors,
    releaseContinuation: () => releaseContinuation?.(),
    releaseChild: () => releaseChild?.(),
    releaseConflictRetry: () => releaseConflictRetry?.(),
    releaseParentInitialization: () => releaseParentInitialization?.(),
    releaseParentTurn: () => releaseParentTurn?.(),
    armNextDelegation: () => {
      firstSessionReuseDelegationId = requests
        .filter((request) => request.role === 'parent')
        .map(
          (request) =>
            request.results.match(
              /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
            )?.[0],
        )
        .find(Boolean);
      if (!firstSessionReuseDelegationId)
        throw new Error('First session-reuse delegation ID was not observed');
      armNextDelegation = true;
    },
    async close() {
      releaseParentInitialization?.();
      releaseContinuation?.();
      releaseChild?.();
      releaseConflictRetry?.();
      releaseParentTurn?.();
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
