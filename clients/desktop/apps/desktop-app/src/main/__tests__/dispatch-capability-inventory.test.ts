/**
 * Every production call of the final dispatchers passes a dispatch
 * capability, and the dispatchers refuse a call without one (phase 35c6b).
 * A new production caller fails here until it takes the queue's admission.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const MAIN = join(__dirname, '..');
const DISPATCHERS = [
  'dispatchWorktreeChatTurn',
  'dispatchAppAdvisorChatMessage',
] as const;

function productionFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory())
      return name === '__tests__' ? [] : productionFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

/** The argument text of the call whose `(` is at `open`. */
function callArguments(source: string, open: number): string {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return source.slice(open);
}

it('passes a capability at every production call of the final dispatchers', () => {
  const calls: string[] = [];
  const missing: string[] = [];
  for (const file of productionFiles(MAIN)) {
    const source = readFileSync(file, 'utf8');
    for (const name of DISPATCHERS) {
      const pattern = new RegExp(`\\b${name}\\(`, 'g');
      for (
        let match = pattern.exec(source);
        match !== null;
        match = pattern.exec(source)
      ) {
        const preceding = source.slice(
          Math.max(0, match.index - 16),
          match.index,
        );
        if (/function\s+$/.test(preceding)) continue;
        const site = `${relative(MAIN, file)} ${name}`;
        calls.push(site);
        const open = match.index + match[0].length - 1;
        if (!callArguments(source, open).includes('authorization'))
          missing.push(site);
      }
    }
  }
  expect(missing).toEqual([]);
  expect(calls.sort()).toEqual([
    'app-advisor/chat-service.ts dispatchAppAdvisorChatMessage',
    'ipc/chat.ts dispatchAppAdvisorChatMessage',
    'lib/builtin-gh-chat.ts dispatchWorktreeChatTurn',
    'lib/hook-chat.ts dispatchWorktreeChatTurn',
    'lib/rebase-resolution-chat.ts dispatchWorktreeChatTurn',
    'lib/worktree-chat-turn.ts dispatchWorktreeChatTurn',
    'services/chat-service.ts dispatchAppAdvisorChatMessage',
    'services/chat-service.ts dispatchWorktreeChatTurn',
    'services/chat-service.ts dispatchWorktreeChatTurn',
    'services/standalone-chat-service.ts dispatchWorktreeChatTurn',
  ]);
});
