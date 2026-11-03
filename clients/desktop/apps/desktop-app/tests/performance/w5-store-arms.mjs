import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { W5_STORE_ARMS, parseW5StoreArm } from './profiles.mjs';

/**
 * W5 store arms (CAN-5532, B6): one E2E build launched with the shipped
 * in-process W5 store or the daemon-backed store over the in-process record
 * port loopback. The arm is a launch treatment, recorded in the result's
 * `treatment`, never in its workload `config`.
 */

export { W5_STORE_ARMS, parseW5StoreArm };
export const W5_STORE_ENV = 'CANOPY_PERFORMANCE_W5_STORE';
export const W5_STORE_EXPERIMENT_ID = 'w5-daemon-record-store';

/** `<baseline>,<candidate>`, each a W5 store arm. */
export function parseW5StoreArms(value) {
  const arms = String(value).split(',');
  if (arms.length !== 2)
    throw new Error('--w5-store-arms expects <baseline>,<candidate>');
  const [baseline, candidate] = arms.map((arm) =>
    parseW5StoreArm(arm.trim(), '--w5-store-arms'),
  );
  return { baseline, candidate };
}

/** The launch environment that selects `arm`; empty when no arm was asked for. */
export function w5StoreLaunchEnv(arm) {
  return arm ? { [W5_STORE_ENV]: arm } : {};
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * The comparator's treatment record for `arm`: `off` is the in-process store,
 * `on` the daemon-backed one. Both arms of one comparison launch the same
 * artifact, so only `arm`, `enabled` and `choice` may differ.
 */
export function w5StoreTreatment(
  arm,
  { bundleEntry, brand = process.env.CANOPY_BRAND || 'canopy' },
) {
  const enabled = parseW5StoreArm(arm) === 'daemon-record-port';
  return {
    experimentId: W5_STORE_EXPERIMENT_ID,
    arm: enabled ? 'on' : 'off',
    enabled,
    choice: enabled,
    artifactSha256: sha256File(bundleEntry),
    brand,
  };
}

/** Caveats every W5 store arm result carries, whatever the arm. */
export function w5StoreCaveats(arm) {
  return [
    `W5 store arm ${arm}. The daemon-record-port arm runs the record-port authority, framing and preflight on Electron main over an in-memory loopback: main-thread cost is overstated, and with no socket hop or daemon process, latency is understated. Loopback results are E2E-relative evidence only.`,
    'The daemon-record-port arm writes only where the storage ownership rows admit the daemon writer; otherwise every W5 write is a counted typed refusal (w5 port.commit.refused.writeRefused.*), and write timings measure the refusal.',
  ];
}
