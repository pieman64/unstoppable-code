import { createScriptEnvVarToken } from '@canopy/desktop-shared/scripts';

export function createScriptEnvVarInsertion(variableName: string): string {
  return createScriptEnvVarToken(variableName);
}

export { insertTextAtSelection } from './textInsertion';
