// Inspect `ps -wwE -p <pid> -o command=` output (macOS shows the environment of
// same-user processes after the command line). Reports variable NAMES only,
// except HOME/CODEX_HOME values (synthetic paths, compared to the layout).
import { isCredentialName } from '../shared/child-env.mjs';
import { isInside } from '../shared/synthetic-root.mjs';

const ASSIGNMENT = /(?:^|\s)([A-Z_][A-Z0-9_]*)=/g;

/** Parse env-looking `NAME=value` tokens (uppercase names only; config keys are lowercase). */
export function parsePsEnvironment(text) {
  const matches = [...text.matchAll(ASSIGNMENT)];
  const env = {};
  matches.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end =
      index + 1 < matches.length ? matches[index + 1].index : text.length;
    env[match[1]] = text.slice(start, end).trim();
  });
  return env;
}

/**
 * @param {string} text ps output
 * @param {{ root: string, home: string, codexHome: string }} layout
 * @returns {{ status: 'pass'|'fail'|'blocked', names: string[], credentialNames: string[], problems: string[] }}
 */
export function inspectProcessEnvironment(text, layout) {
  const env = parsePsEnvironment(text);
  const names = Object.keys(env).sort();
  // `ps -E` of a process whose env is hidden prints only the command line.
  if (names.length === 0 || !('HOME' in env))
    return {
      status: 'blocked',
      names,
      credentialNames: [],
      problems: ['process environment not readable through ps -E'],
    };
  const problems = [];
  if (!isInside(layout.root, env.HOME))
    problems.push('HOME outside the synthetic root');
  if ('CODEX_HOME' in env && !isInside(layout.root, env.CODEX_HOME))
    problems.push('CODEX_HOME outside the synthetic root');
  const credentialNames = names.filter((name) => isCredentialName(name));
  if (credentialNames.length > 0)
    problems.push(
      `credential-looking variables present: ${credentialNames.join(', ')}`,
    );
  return {
    status: problems.length === 0 ? 'pass' : 'fail',
    names,
    credentialNames,
    problems,
  };
}
