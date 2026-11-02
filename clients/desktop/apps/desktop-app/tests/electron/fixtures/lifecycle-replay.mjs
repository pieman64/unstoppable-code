import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { validateFixture } from '../../../../../scripts/harness-contract/lifecycle/schema.mjs';

const REPLAY_FIXTURE_ENV = 'CANOPY_LIFECYCLE_REPLAY_FIXTURE';
const PATH_ENVIRONMENT_VARIABLES = [
  ['CANOPY_LIFECYCLE_REPLAY_MODULE', 'modulePath'],
  ['CANOPY_LIFECYCLE_REPLAY_LOG', 'logPath'],
  ['CANOPY_LIFECYCLE_REPLAY_GATES', 'gatesDir'],
];

function requireAbsolutePath(value, variable) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError(`${variable} must be an absolute path`);
  }
  return value;
}

function parseJsonEnvironment(env, variable, fallback) {
  const value = env[variable];
  if (value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new TypeError(`${variable} must contain valid JSON`, {
      cause: error,
    });
  }
}

function isValidGateName(name) {
  if (typeof name !== 'string') return false;
  const beforeMatch = /^before-(\d+)$/.exec(name);
  if (beforeMatch) return Number.isSafeInteger(Number(beforeMatch[1]));
  return /^release-[A-Za-z0-9._-]+$/.test(name);
}

function assertGateName(name) {
  if (!isValidGateName(name)) {
    throw new TypeError(`Invalid replay gate name: ${String(name)}`);
  }
  return name;
}

/** Read and validate the opt-in lifecycle replay environment configuration. */
export function readReplayEnv(env = process.env) {
  const rawFixturePath = env[REPLAY_FIXTURE_ENV];
  if (rawFixturePath === undefined) return undefined;

  const fixturePath = requireAbsolutePath(rawFixturePath, REPLAY_FIXTURE_ENV);
  const paths = Object.fromEntries(
    PATH_ENVIRONMENT_VARIABLES.map(([variable, property]) => [
      property,
      env[variable] === undefined
        ? undefined
        : requireAbsolutePath(env[variable], variable),
    ]),
  );

  const armedGates = parseJsonEnvironment(
    env,
    'CANOPY_LIFECYCLE_REPLAY_ARMED_GATES',
    [],
  );
  if (
    !Array.isArray(armedGates) ||
    armedGates.some((name) => typeof name !== 'string')
  ) {
    throw new TypeError(
      'CANOPY_LIFECYCLE_REPLAY_ARMED_GATES must be a JSON array of gate names',
    );
  }
  for (const name of armedGates) assertGateName(name);
  if (armedGates.length > 0 && paths.gatesDir === undefined) {
    throw new TypeError(
      'CANOPY_LIFECYCLE_REPLAY_GATES directory is required when armed gates are configured',
    );
  }

  const rawDelays = parseJsonEnvironment(
    env,
    'CANOPY_LIFECYCLE_REPLAY_DELAYS',
    {},
  );
  if (
    rawDelays === null ||
    Array.isArray(rawDelays) ||
    typeof rawDelays !== 'object'
  ) {
    throw new TypeError('CANOPY_LIFECYCLE_REPLAY_DELAYS must be a JSON object');
  }
  const delays = {};
  for (const [index, milliseconds] of Object.entries(rawDelays)) {
    if (!/^(0|[1-9]\d*)$/.test(index) || !Number.isSafeInteger(Number(index))) {
      throw new TypeError(`Invalid lifecycle replay delay index: ${index}`);
    }
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new TypeError(
        `Lifecycle replay delay at index ${index} must be a non-negative integer`,
      );
    }
    delays[Number(index)] = milliseconds;
  }

  return {
    fixturePath,
    modulePath: paths.modulePath,
    logPath: paths.logPath,
    gatesDir: paths.gatesDir,
    armedGates,
    delays,
  };
}

/** Read JSON from an absolute path and validate it against the fixture contract. */
export function loadReplayFixture(absPath) {
  const fixturePath = requireAbsolutePath(absPath, 'Lifecycle fixture path');
  let source;
  try {
    source = readFileSync(fixturePath, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read lifecycle fixture at ${fixturePath}: ${error.message}`,
      {
        cause: error,
      },
    );
  }

  let fixture;
  try {
    fixture = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Could not parse lifecycle fixture at ${fixturePath}: ${error.message}`,
      {
        cause: error,
      },
    );
  }

  try {
    return validateFixture(fixture);
  } catch (error) {
    throw new Error(
      `Invalid lifecycle fixture at ${fixturePath}: ${error.message}`,
      {
        cause: error,
      },
    );
  }
}

function isStartedAgentThread(step) {
  return (
    typeof step?.ids?.agentThread === 'string' &&
    step?.fields?.subagentKind === 'started'
  );
}

function collectStartedAgentThreads(steps, target) {
  for (const step of steps) {
    if (step.kind === 'group') {
      for (const lane of step.lanes) collectStartedAgentThreads(lane, target);
    } else if (isStartedAgentThread(step)) {
      target.add(step.ids.agentThread);
    }
  }
}

function isBlockedChildStep(step, startedInGroup, registeredAgentThreads) {
  if (typeof step?.lane !== 'string' || !step.lane.startsWith('child:'))
    return false;
  const alias = step.lane.slice('child:'.length);
  return startedInGroup.has(alias) && !registeredAgentThreads.has(alias);
}

function appendStep(step, output, registeredAgentThreads) {
  output.push({ step, index: output.length });
  if (isStartedAgentThread(step))
    registeredAgentThreads.add(step.ids.agentThread);
}

function createGroupState(group) {
  return {
    lanes: group.lanes.map((lane) => ({
      cursor: 0,
      steps: lane.map((step) =>
        step.kind === 'group' ? { group: createGroupState(step) } : { step },
      ),
    })),
  };
}

function normalizeGroupState(state) {
  for (const lane of state.lanes) {
    while (lane.cursor < lane.steps.length) {
      const nestedGroup = lane.steps[lane.cursor].group;
      if (!nestedGroup) break;
      normalizeGroupState(nestedGroup);
      if (
        nestedGroup.lanes.some(
          (nestedLane) => nestedLane.cursor < nestedLane.steps.length,
        )
      ) {
        break;
      }
      lane.cursor += 1;
    }
  }
}

function findNextStep(state, startedInGroup, registeredAgentThreads) {
  normalizeGroupState(state);
  for (const lane of state.lanes) {
    if (lane.cursor >= lane.steps.length) continue;
    const current = lane.steps[lane.cursor];
    if (current.group) {
      const nestedStep = findNextStep(
        current.group,
        startedInGroup,
        registeredAgentThreads,
      );
      if (nestedStep) return nestedStep;
      continue;
    }
    if (
      !isBlockedChildStep(current.step, startedInGroup, registeredAgentThreads)
    ) {
      return { lane, step: current.step };
    }
  }
  return undefined;
}

function flattenGroup(group, output) {
  const state = createGroupState(group);
  const startedInGroup = new Set();
  collectStartedAgentThreads([group], startedInGroup);
  const registeredAgentThreads = new Set();

  while (true) {
    normalizeGroupState(state);
    if (state.lanes.every((lane) => lane.cursor >= lane.steps.length)) return;

    const next = findNextStep(state, startedInGroup, registeredAgentThreads);
    if (!next) {
      throw new Error(
        'Lifecycle replay group has a dependency cycle: all remaining lanes are blocked',
      );
    }
    next.lane.cursor += 1;
    appendStep(next.step, output, registeredAgentThreads);
  }
}

/** Flatten steps into deterministic emission order, respecting group lane dependencies. */
export function scheduleSteps(fixture) {
  const output = [];
  for (const step of fixture.steps) {
    if (step.kind === 'group') {
      flattenGroup(step, output);
    } else {
      output.push({ step, index: output.length });
    }
  }
  return output;
}

/** Create a synchronous JSON-lines logger containing replay metadata only. */
export function createReplayLog(logPath) {
  return {
    write(record) {
      if (logPath === undefined) return;
      const safeRecord = {};
      for (const key of ['kind', 'index', 'type', 'action', 'name']) {
        if (record[key] !== undefined) safeRecord[key] = record[key];
      }
      appendFileSync(logPath, `${JSON.stringify(safeRecord)}\n`, 'utf8');
    },
  };
}

/** Create opt-in filesystem gates for pausing individual replay steps. */
export function createGates({ dir, armed = [], timeoutMs = 30000 }) {
  if (!Array.isArray(armed))
    throw new TypeError('Replay gates must be an array of names');
  if (dir !== undefined && (typeof dir !== 'string' || dir.length === 0)) {
    throw new TypeError('Replay gates directory must be a non-empty path');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('Replay gate timeout must be a non-negative integer');
  }
  for (const name of armed) assertGateName(name);
  if (armed.length > 0 && dir === undefined) {
    throw new TypeError(
      'A gates directory is required when replay gates are armed',
    );
  }

  const armedNames = new Set(armed);
  return {
    isArmed(name) {
      assertGateName(name);
      return armedNames.has(name);
    },
    async wait(name) {
      assertGateName(name);
      if (!armedNames.has(name)) return;
      const gatePath = path.join(dir, name);
      const deadline = Date.now() + timeoutMs;
      while (true) {
        if (existsSync(gatePath)) return;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new Error(`replay_gate_timeout: timed out waiting for ${name}`);
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(25, remainingMs)),
        );
      }
    },
    release(name) {
      assertGateName(name);
      if (dir === undefined) {
        throw new TypeError(
          'A gates directory is required to release a replay gate',
        );
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, name), '', 'utf8');
    },
  };
}

function writeLog(log, record) {
  if (log?.write) log.write(record);
}

async function waitForGate(gates, log, name, index) {
  writeLog(log, { kind: 'gate', index, name });
  await gates.wait(name);
}

/** Replay scheduled steps through a provider-specific adapter. */
export async function runReplay({ fixture, adapter, log, gates, delays = {} }) {
  try {
    for (const { step, index } of scheduleSteps(fixture)) {
      const delayMs = delays[index];
      if (delayMs !== undefined) {
        if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
          throw new TypeError(
            `Lifecycle replay delay at index ${index} must be a non-negative integer`,
          );
        }
        if (delayMs > 0) {
          writeLog(log, { kind: 'delay', index });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      await waitForGate(gates, log, `before-${index}`, index);
      if (step.kind === 'frame') {
        writeLog(log, { kind: 'frame', index, type: step.type });
        await adapter.emitFrame(step, index);
      } else {
        if (step.action === 'release' && step.barrier) {
          await waitForGate(gates, log, `release-${step.barrier}`, index);
        }
        writeLog(log, { kind: 'control', index, action: step.action });
        await adapter.handleControl(step, index);
      }
    }
  } catch (error) {
    writeLog(log, { kind: 'error' });
    throw error;
  }

  writeLog(log, { kind: 'done' });
}
