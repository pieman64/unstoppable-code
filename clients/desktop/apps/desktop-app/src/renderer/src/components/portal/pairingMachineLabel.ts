/**
 * Names the machine being paired in Remote Control copy (CAN-2938), or a
 * neutral stand-in when the name is unknown.
 */
export function pairingMachineLabel(machineName: string | null): string {
  return machineName && machineName.trim() !== ''
    ? machineName
    : 'this computer';
}
