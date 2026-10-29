// Synthetic page observations at the experiment's structural bound
// (100 controls, 6,000 visible-text characters), validated against the
// portable observation schema. Each observation embeds a unique sentinel so
// rotation tests can prove an earlier page never reaches a new session.
import { createHash } from 'node:crypto';
import {
  BROWSER_AGENT_CONTRACT_VERSION,
  BROWSER_AGENT_EXPERIMENT_LIMITS,
  BrowserAgentObservationSchema,
} from '@canopy/protocol/delegation/browser-agent';

const WORDS = [
  'invoice',
  'account',
  'region',
  'status',
  'quarter',
  'shipment',
  'ledger',
  'catalog',
  'order',
  'priority',
  'summary',
  'detail',
  'contact',
  'history',
];
const ROLES = [
  'button',
  'link',
  'textbox',
  'checkbox',
  'combobox',
  'tab',
  'menuitem',
];

function filler(length, seed) {
  let out = '';
  let index = seed;
  while (out.length < length) {
    out += `${WORDS[index % WORDS.length]} ${index} `;
    index += 7;
  }
  return out.slice(0, length);
}

function hex32(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/**
 * Build one observation.
 *
 * @param {{ sentinel: string, epoch: number, step: number, controls?: number, textCharacters?: number, omittedCharacters?: number, delegationId?: string }} options
 */
export function buildSyntheticObservation({
  sentinel,
  epoch,
  step,
  controls = BROWSER_AGENT_EXPERIMENT_LIMITS.observation.controls,
  textCharacters = BROWSER_AGENT_EXPERIMENT_LIMITS.observation.textCharacters,
  omittedCharacters = 1_500,
  delegationId = 'probe-delegation',
}) {
  const docKey = hex32(`${sentinel}:${epoch}`);
  const list = [];
  for (let index = 0; index < controls; index += 1) {
    const role = index === 3 ? 'select' : ROLES[index % ROLES.length];
    const control = {
      ref: `input-${docKey}-${index}`,
      role,
      name:
        index === 0
          ? `Search ${sentinel}`
          : `${WORDS[index % WORDS.length]} control ${index}`,
      inViewport: index < 40,
    };
    if (role === 'textbox')
      control.value = `${WORDS[(index + 3) % WORDS.length]} ${index}`;
    if (role === 'checkbox') control.state = { checked: index % 2 === 0 };
    if (role === 'select')
      control.options = {
        entries: ['North', 'South', 'East', 'West', 'Central'].map(
          (label, n) => ({ label, selected: n === 0 }),
        ),
        total: 12,
        omitted: 7,
      };
    list.push(control);
  }
  const head = `Page ${sentinel} step ${step}. `;
  const text = head + filler(textCharacters - head.length, step + epoch * 31);
  const observation = {
    version: BROWSER_AGENT_CONTRACT_VERSION,
    observationId: `obs-${epoch}-${step}-${docKey.slice(0, 8)}`,
    epoch: { delegationId, runGeneration: 1, epoch },
    runtime: { browserId: 'probe-tab-1', runtimeGeneration: 1 },
    document: {
      documentId: `doc-${docKey.slice(0, 12)}`,
      navigationRevision: epoch,
    },
    interaction: { revision: step, userInteracted: false },
    capturedAt: 1_790_000_000_000 + epoch * 1_000 + step,
    page: {
      url: `https://lab.invalid/epoch-${epoch}/table`,
      title: `Synthetic lab page ${epoch}`,
      loading: false,
      visible: true,
      viewport: {
        width: 1280,
        height: 800,
        scrollX: 0,
        scrollY: step * 400,
        scrollWidth: 1280,
        scrollHeight: 12_000,
      },
    },
    controls: list,
    controlCoverage: {
      found: controls + 40,
      returned: controls,
      omittedOverLimit: 38,
      omittedUnsupported: 2,
    },
    visibleText: {
      text,
      totalCharacters: text.length + omittedCharacters,
      omittedCharacters,
    },
    redactedValues: 1,
  };
  return BrowserAgentObservationSchema.parse(observation);
}

/** Serialized observation text as a tool result would carry it. */
export function observationToolText(observation) {
  return JSON.stringify(observation);
}

/** A per-epoch page sentinel (matches the capture canary pattern). */
export function pageSentinel(epoch, nonce) {
  return `BAP0_PAGE_E${epoch}_${nonce}`;
}
