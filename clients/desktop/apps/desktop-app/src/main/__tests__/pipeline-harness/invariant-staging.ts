import type { InvariantId, InvariantStagingEntry } from './contracts';

function enabled(introducedBy: readonly string[]): InvariantStagingEntry {
  return { status: 'enabled', introducedBy, subclaims: [], reason: '' };
}

/** Staged for good: the rest of the claim is checked outside the harness. */
function covered(
  status: 'partial' | 'external',
  introducedBy: readonly string[],
  coveredBy: readonly string[],
  reason: string,
  subclaims: readonly string[] = [],
): InvariantStagingEntry {
  return { status, introducedBy, coveredBy, reason, subclaims };
}

const ELECTRON = 'apps/desktop-app/tests/electron';
const PIPELINE = 'apps/desktop-app/src/main/__tests__';

/** Staging is deliberate: a passing pipeline trace does not prove UI or future reducer claims. */
export const INVARIANT_STAGING: Record<InvariantId, InvariantStagingEntry> = {
  1: enabled(['03', '35c5b']),
  2: enabled(['35c5b']),
  3: enabled(['35c5b']),
  4: enabled(['35c5b']),
  5: enabled(['08', '18', '19a', '35c5b']),
  // The paired run is provider-turn-window-differential.pipeline.test.ts;
  // provider-frame-window.test.ts keeps the reducer-level differential.
  6: enabled(['16', '43h']),
  7: enabled(['34']),
  8: covered(
    'partial',
    ['35d2', '43d', '43e'],
    [
      `${ELECTRON}/turn-state-background-surfaces.spec.mjs`,
      `${ELECTRON}/chat-auto-archive.spec.mjs`,
    ],
    "Each turn captures its turn diff exactly once, a turn Stop's abort fallback ends included (43e), and a chat's completion waits for idle. The renderer's chat-level effects run in Electron flows: the held completion notice shows once, after the wake (43i), and auto-archive.",
    [
      'A turn-diff or code-review end effect fires at most once per turn end of its chat.',
      'A chat that captures turn diffs captures exactly one for each turn it ended.',
      "A chat's completion is reported only while none of its turns runs, and each turn's completion at most once until the chat ends another turn.",
    ],
  ),
  9: enabled(['19d']),
  10: covered(
    'external',
    ['30'],
    [
      `${ELECTRON}/turn-state-background-surfaces.spec.mjs`,
      `${ELECTRON}/chat-stale-provider-event.spec.mjs`,
      `${ELECTRON}/portal/portal-turn-state-background.spec.mjs`,
    ],
    'Only rendered surfaces can show it. Electron and Portal flows (43i) check Stop, the composer, the timer, the tab, the worktree row, the background tray and the stuck banner against the committed runtime through foreground, background-only and idle, and through a wake.',
  ),
  11: covered(
    'partial',
    ['25'],
    [
      `${PIPELINE}/provider-turn-latency.pipeline.test.ts`,
      `${PIPELINE}/provider-turn-latency-hosts.pipeline.test.ts`,
    ],
    'Structural prompt handoff is checked; absolute p95 timing runs only with CANOPY_PIPELINE_ABSOLUTE=1 on an idle host, not as universal performance evidence.',
    [
      'Committed prompts reach the provider; opt-in p95 real-time latency is below 2000 ms.',
    ],
  ),
  12: enabled(['26']),
  13: enabled([
    '11a',
    '11b',
    '11c',
    '12',
    '13a',
    '13b',
    '21',
    '22',
    '23a',
    '23b',
    '23c',
    '23d',
  ]),
  14: covered(
    'partial',
    ['12'],
    [`${ELECTRON}/chat-queue.spec.mjs`],
    'The desktop hides an internal delegation request’s queue row and never renders its text (chat-queue.spec.mjs). The Portal side is open: portal-parity-delegation-waiting.spec.mjs stays fixme, re-enabled and still failing in 43i.',
    [
      'Queue broadcasts and unrelated provider-bound frames never expose registered secret text.',
    ],
  ),
  15: enabled(['13a', '35c5b']),
  16: covered(
    'partial',
    ['04', '22'],
    [`${PIPELINE}/provider-turn-lifecycle-worktree.pipeline.test.ts`],
    'The Claude receipt split is checked with held commits; universal control latency remains unproven, and real-time checks run only with CANOPY_PIPELINE_ABSOLUTE=1 on an idle host.',
    [
      'Claude steer settlement precedes held-commit release; opt-in settlement latency is below 1000 ms.',
    ],
  ),
  17: enabled(['02a', '02b', '02c', '02d', '02e', '02f', '03', '07', '25']),
  18: enabled(['05']),
  19: enabled(['01', '35c5b']),
  20: enabled(['05', '10']),
  21: enabled(['21', '22', '23a', '23b', '23c', '23d']),
};

/** Exact audit §8 text, kept beside staging so diagnostics never paraphrase the claim as proven. */
export const INVARIANT_TEXT: Record<InvariantId, string> = {
  1: 'One timer per turn, keyed by turn id. A settled timer row never changes.',
  2: 'foreground holds exactly when the current turn’s timer is open or paused.',
  3: 'No open timer after settle, Stop, restart or session removal.',
  4: 'Child, replayed and late frames never change the chat state, the queue gate or a timer.',
  5: 'Queue busy and session turnActive agree with foreground. The wake lock stays held while either a foreground turn or live background work exists.',
  6: 'Reduction against the window equals reduction against the full transcript.',
  7: 'Replaying a stream twice is a no-op.',
  8: 'Each per-turn effect fires once per turn; each chat-level effect fires once per transition to idle.',
  9: 'A terminal event never writes a result onto a live child’s tool call.',
  10: 'Every renderer surface (Stop, queue placeholder, stuck banner, tab and sidebar) agrees with canonical runtime within a short grace period of each committed change. No renderer-local writer can hold streaming while the runtime is terminal.',
  11: 'Prompt commit to provider handoff stays under 2 s p95, independent of transcript size.',
  12: 'A restart-requiring settings change never stops live native background work without the user choosing to.',
  13: 'A generated message that arrives during a foreground turn is steered, or queued with a visible reason. A queued one is delivered within a short bound of the first moment delivery becomes possible.',
  14: 'Internal payload text is never rendered, and every surface hides the same queue rows.',
  15: 'The queue gate is never armed for longer than a short bound without a foreground turn at the provider.',
  16: 'Handling a control frame (a response, a turn start or end, a tool call) takes under 1 s p95, whatever the persistence backlog.',
  17: 'A progress update never rewrites committed transcript bytes, and a turn start never moves them. A recorded patch may amend only a native completed command’s original row with its exact aggregate tool_result; all prior fields, blocks, identities and other rows remain unchanged. A recorded patch may also move only an existing Codex agent card’s status and a running child state to terminal after that child’s terminal frame, recording that child’s settle time; all other fields, blocks, identities and rows remain unchanged.',
  18: 'No tool-call side effect runs after the provider cancelled the call.',
  19: 'Every turn the provider runs, including one it starts by itself, has a session turn from its start to its root terminal event. Turn-scoped authority, steering and accounting read that turn and never borrow a queued message’s id.',
  20: 'Watcher delivery never depends on a renderer window or on the renderer’s view of the chat, and a retried tool call never creates a second registration.',
  21: 'A steered message reads uncertain only while the provider may have taken it and Canopy can’t yet tell. A refusal, a late acknowledgement or the provider’s history always settles the row, and a generated message the provider didn’t take is sent as an ordinary message exactly once.',
};
