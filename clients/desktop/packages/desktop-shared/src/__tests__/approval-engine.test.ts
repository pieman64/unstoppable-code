import {
  evaluateApproval,
  containsAnsiCQuoting,
  containsNestedShellExecution,
  containsShellLineContinuation,
  containsShellBraceExpansion,
  containsShellPathnameExpansion,
  containsShellParameterExpansion,
  containsShellRedirection,
  containsInterpreterPayload,
  suggestedCommandPattern,
  splitCommandChain,
  commandPatternMatches,
  ruleMatchesCheck,
  isApprovalMode,
  normalizeApprovalRules,
  recursiveForcedRemoveOperands,
} from '../lib/approval-engine';
import { getAppAdvisorLedgerToolNames } from '../lib/app-advisor-tools';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '../lib/canopy-injected-tools';
import type {
  ApprovalCheck,
  ApprovalRule,
  ApprovalEvaluationContext,
} from '../types/approvals';

function rule(
  partial: Partial<ApprovalRule> & Pick<ApprovalRule, 'behavior' | 'target'>,
): ApprovalRule {
  return {
    id: 'r1',
    createdAt: '2026-07-20T00:00:00.000Z',
    origin: 'prompt',
    ...partial,
  };
}

function ctx(
  overrides: Partial<ApprovalEvaluationContext> = {},
): ApprovalEvaluationContext {
  return {
    mode: 'ask',
    rules: { session: [], project: [], global: [] },
    ...overrides,
  };
}

describe('safety denial reasons', () => {
  it.each(['ask', 'auto'] as const)(
    'reports existing denials in %s without changing policy',
    (mode) => {
      for (const [command, safetyReason] of [
        ['git push --force origin HEAD', 'force-push'],
        ['git push -f origin master', 'force-push'],
        ['git push --force', 'force-push'],
        ['git -C /repo push --force origin main', 'force-push'],
        [
          'sudo /usr/bin/git -C /repo push -vf origin refs/heads/main',
          'force-push',
        ],
        ['env git push --force-with-lease origin main', 'force-push'],
        ['rm -rf /', 'destructive-delete'],
        ['find . -delete', 'destructive-delete'],
        ['git push --delete origin main', 'destructive-delete'],
        ['git push origin :master', 'destructive-delete'],
        ['mkfs /dev/sda', 'disk-write'],
        ['dd if=/dev/zero of=/dev/sda', 'disk-write'],
        ['echo $(git push --force origin HEAD)', 'unverifiable-command'],
        ['sh -c "git push --force origin HEAD"', 'unverifiable-command'],
        ['echo safe; git push -f origin main; mkfs /dev/sda', 'force-push'],
        ['mkfs /dev/sda; git push -f origin main', 'disk-write'],
        ['git push -f origin main; echo $(date)', 'unverifiable-command'],
        ['git push -f origin main; find . -delete', 'destructive-delete'],
      ]) {
        expect(
          evaluateApproval({ kind: 'command', command }, ctx({ mode })),
        ).toEqual({
          outcome: 'deny',
          safety: true,
          safetyReason,
        });
      }
    },
  );

  it('preserves saved rule precedence and the Full access bypass without safety metadata', () => {
    const saved = rule({
      behavior: 'deny',
      target: { kind: 'command', pattern: 'git status' },
    });
    expect(
      evaluateApproval(
        { kind: 'command', command: 'git status' },
        ctx({ rules: { session: [saved], project: [], global: [] } }),
      ),
    ).toEqual({ outcome: 'deny', matchedRule: saved });
    const allow = rule({
      behavior: 'allow',
      target: { kind: 'command', pattern: 'git push *' },
    });
    expect(
      evaluateApproval(
        { kind: 'command', command: 'git push -f origin main' },
        ctx({ rules: { session: [allow], project: [], global: [] } }),
      ),
    ).toEqual({ outcome: 'deny', safety: true, safetyReason: 'force-push' });
    expect(
      evaluateApproval(
        { kind: 'command', command: 'git push -f origin main' },
        ctx({ mode: 'full-access' }),
      ),
    ).toEqual({ outcome: 'allow' });
  });

  it('identifies unprovable path resolution conservatively', () => {
    expect(
      evaluateApproval(
        {
          kind: 'command',
          command: 'rm -rf ./link',
          pathResolutionFailed: true,
          protectedRoots: ['/'],
        },
        ctx(),
      ),
    ).toEqual({
      outcome: 'deny',
      safety: true,
      safetyReason: 'unverifiable-command',
    });
  });
});

describe('splitCommandChain', () => {
  it('splits on shell operators and newlines', () => {
    expect(splitCommandChain('npm test && git push; ls | wc -l')).toEqual([
      'npm test',
      'git push',
      'ls',
      'wc -l',
    ]);
  });
  it('returns single segment for a plain command', () => {
    expect(splitCommandChain('npm run lint:fix')).toEqual(['npm run lint:fix']);
  });
  it('keeps quoted and escaped operators inside their command segment', () => {
    expect(
      splitCommandChain(
        'echo \'ok;./payload\' && printf "left|right"; echo escaped\\&literal',
      ),
    ).toEqual([
      "echo 'ok;./payload'",
      'printf "left|right"',
      'echo escaped\\&literal',
    ]);
  });
  it('uses Windows separator rules instead of treating backslash as escape', () => {
    expect(
      splitCommandChain('Write-Output safe\\; Remove-Item C:\\tmp'),
    ).toEqual(['Write-Output safe\\; Remove-Item C:\\tmp']);
    expect(
      splitCommandChain('Write-Output safe\\; Remove-Item C:\\tmp', 'windows'),
    ).toEqual(['Write-Output safe\\', 'Remove-Item C:\\tmp']);
  });
});

describe('containsNestedShellExecution', () => {
  it('detects substitutions, backticks, subshells, and process substitutions', () => {
    expect(containsNestedShellExecution('echo $(rm -rf /)')).toBe(true);
    expect(containsNestedShellExecution('echo `rm -rf /`')).toBe(true);
    expect(containsNestedShellExecution('(rm -rf /)')).toBe(true);
    expect(containsNestedShellExecution('cat <(rm -rf /)')).toBe(true);
    expect(containsNestedShellExecution('ls =(printf hidden)')).toBe(true);
    expect(containsNestedShellExecution("Remove-Item -Force @('C:\\')")).toBe(
      true,
    );
  });

  it('does not treat escaped grouping characters as nested execution', () => {
    expect(containsNestedShellExecution('echo \\(literal\\)')).toBe(false);
  });

  it('does not let PowerShell backslashes hide command substitutions', () => {
    const command = String.raw`Write-Output C:\tmp\$(Remove-Item C:\secrets)`;

    expect(containsNestedShellExecution(command, 'windows')).toBe(true);
    expect(
      evaluateApproval(
        { kind: 'command', command, shellPlatform: 'windows' },
        ctx({
          rules: {
            session: [
              rule({
                behavior: 'allow',
                target: { kind: 'command', pattern: 'Write-Output *' },
              }),
            ],
            project: [],
            global: [],
          },
        }),
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });

  it('ignores literal parentheses inside quotes', () => {
    expect(containsNestedShellExecution('git commit -m "fix (tests)"')).toBe(
      false,
    );
    expect(containsNestedShellExecution("printf '%s' '(literal)'")).toBe(false);
  });

  it('still detects shell expansion inside double quotes', () => {
    expect(containsNestedShellExecution('echo "$(rm -rf /)"')).toBe(true);
    expect(containsNestedShellExecution('echo "`rm -rf /`"')).toBe(true);
    expect(containsNestedShellExecution("echo '$(literal)'")).toBe(false);
  });
});

describe('containsShellLineContinuation', () => {
  it('detects LF and CRLF continuations outside single quotes', () => {
    expect(containsShellLineContinuation('r\\\nm -rf /')).toBe(true);
    expect(containsShellLineContinuation('r\\\r\nm -rf /')).toBe(true);
    expect(containsShellLineContinuation('"r\\\nm" -rf /')).toBe(true);
  });

  it('ignores literal backslash-newline text inside single quotes', () => {
    expect(containsShellLineContinuation("'r\\\nm' -rf /")).toBe(false);
  });
});

describe('containsShellParameterExpansion', () => {
  it('detects named, braced, positional, and special parameters', () => {
    expect(containsShellParameterExpansion('rm -rf "$HOME"')).toBe(true);
    expect(containsShellParameterExpansion('rm -rf "${HOME}/tmp"')).toBe(true);
    expect(containsShellParameterExpansion('echo $1 $@ $?')).toBe(true);
  });

  it('ignores escaped and single-quoted dollar signs', () => {
    expect(containsShellParameterExpansion("echo '$HOME'")).toBe(false);
    expect(containsShellParameterExpansion('echo \\$HOME')).toBe(false);
  });

  it('uses Windows escape and percent-expansion semantics', () => {
    expect(
      containsShellParameterExpansion(
        String.raw`Write-Output C:\tmp\$env:USERPROFILE`,
        'windows',
      ),
    ).toBe(true);
    expect(
      containsShellParameterExpansion('rd /s /q %USERPROFILE%', 'windows'),
    ).toBe(true);
    expect(
      containsShellParameterExpansion('rd /s /q "%USERPROFILE%"', 'windows'),
    ).toBe(true);
    expect(
      containsShellParameterExpansion('rd /s /q %USERPROFILE:~0%', 'windows'),
    ).toBe(true);
    expect(
      containsShellParameterExpansion(
        'rd /s /q %USERPROFILE:Users=Temp%',
        'windows',
      ),
    ).toBe(true);
  });
});

describe('containsShellPathnameExpansion', () => {
  it('detects unquoted pathname expansion tokens', () => {
    expect(containsShellPathnameExpansion('rm -rf /Users/[t]irish')).toBe(true);
    expect(containsShellPathnameExpansion('rm -rf /Users/*')).toBe(true);
    expect(containsShellPathnameExpansion('rm -rf /Users/t?m')).toBe(true);
  });

  it('allows quoted, escaped, and incomplete pathname patterns', () => {
    expect(containsShellPathnameExpansion("echo '*' '[t]' '?'")).toBe(false);
    expect(containsShellPathnameExpansion('echo \\* \\[t\\] \\?')).toBe(false);
    expect(containsShellPathnameExpansion('echo [literal')).toBe(false);
  });

  it('does not treat Windows path separators as wildcard escapes', () => {
    expect(
      containsShellPathnameExpansion(
        String.raw`Get-ChildItem C:\repo\*`,
        'windows',
      ),
    ).toBe(true);
  });
});

describe('containsAnsiCQuoting', () => {
  it('detects executable ANSI-C quoted tokens', () => {
    expect(containsAnsiCQuoting("rm -rf $'/'")).toBe(true);
    expect(containsAnsiCQuoting("echo prefix$'\\n'suffix")).toBe(true);
  });

  it('ignores escaped and quoted literal spellings', () => {
    expect(containsAnsiCQuoting("echo \\$'literal'")).toBe(false);
    expect(containsAnsiCQuoting(`echo "$'literal'"`)).toBe(false);
  });
});

describe('containsShellBraceExpansion', () => {
  it('detects unquoted list and range expansion', () => {
    expect(containsShellBraceExpansion('rm -rf {/,/tmp}')).toBe(true);
    expect(containsShellBraceExpansion('echo file{1..3}')).toBe(true);
  });

  it('ignores quoted, escaped, and non-expanding braces', () => {
    expect(containsShellBraceExpansion("echo '{a,b}'")).toBe(false);
    expect(containsShellBraceExpansion('echo "\\{a,b\\}"')).toBe(false);
    expect(containsShellBraceExpansion('echo {plain}')).toBe(false);
  });
});

describe('unsupported shell constructs', () => {
  it('detects unquoted redirections but ignores quoted and escaped literals', () => {
    expect(containsShellRedirection('git status > /tmp/status')).toBe(true);
    expect(containsShellRedirection('cat < input.txt')).toBe(true);
    expect(containsShellRedirection("echo 'a > b'")).toBe(false);
    expect(containsShellRedirection('echo \\>')).toBe(false);
    expect(
      containsShellRedirection(
        String.raw`type C:\tmp\input > output.txt`,
        'windows',
      ),
    ).toBe(true);
  });

  it('detects inline interpreter payloads across common runtimes', () => {
    expect(containsInterpreterPayload("bash -c 'echo safe'")).toBe(true);
    expect(containsInterpreterPayload('python3 -c "print(1)"')).toBe(true);
    expect(containsInterpreterPayload('python -m pytest')).toBe(true);
    expect(containsInterpreterPayload('python3.12 -m pytest')).toBe(true);
    expect(containsInterpreterPayload('node --eval "process.exit()"')).toBe(
      true,
    );
    expect(containsInterpreterPayload('node -p "process.version"')).toBe(true);
    expect(containsInterpreterPayload('node --print "process.version"')).toBe(
      true,
    );
    expect(
      containsInterpreterPayload('osascript -e \'display dialog "Hi"\''),
    ).toBe(true);
    expect(containsInterpreterPayload("sudo bash -c 'echo safe'")).toBe(true);
    expect(
      containsInterpreterPayload('/usr/bin/env python3 -c "print(1)"'),
    ).toBe(true);
    expect(containsInterpreterPayload('python3.12 -c "print(1)"')).toBe(true);
    expect(containsInterpreterPayload('python.exe -c "print(1)"')).toBe(true);
    expect(containsInterpreterPayload('py -c "print(1)"')).toBe(true);
    expect(containsInterpreterPayload('py.exe -c "print(1)"')).toBe(true);
    expect(containsInterpreterPayload('node20.exe -p "process.version"')).toBe(
      true,
    );
    expect(containsInterpreterPayload('pwsh -e ZQBjAGgAbwAgAG8AawA=')).toBe(
      true,
    );
    expect(
      containsInterpreterPayload(
        'powershell.exe -EncodedCommand ZQBjAGgAbwAgAG8AawA=',
      ),
    ).toBe(true);
    expect(
      containsInterpreterPayload('pwsh --encodedcommand=ZQBjAGgAbwAgAG8AawA='),
    ).toBe(true);
    expect(containsInterpreterPayload('bash script.sh')).toBe(false);
    expect(containsInterpreterPayload("awk -F, '{ print $1 }' data.csv")).toBe(
      true,
    );
    expect(containsInterpreterPayload('eval rm -rf /')).toBe(true);
    expect(containsInterpreterPayload('command eval rm -rf /')).toBe(true);
    expect(
      containsInterpreterPayload("Invoke-Expression 'Remove-Item C:\\\\'"),
    ).toBe(true);
    expect(containsInterpreterPayload("iex 'Remove-Item C:\\\\'")).toBe(true);
    expect(suggestedCommandPattern('eval rm -rf /')).toBe('eval rm -rf /');
  });

  it('detects clustered and attached interpreter payload flags', () => {
    for (const command of [
      "bash -lc 'rm -rf /'",
      "bash -ec 'rm -rf /'",
      "sh -xc 'rm -rf /'",
      'node -eprocess.exit\\(\\)',
      'node --eval=process.exit\\(\\)',
      'cmd.exe /crm /s /q C:\\\\',
    ]) {
      expect(containsInterpreterPayload(command)).toBe(true);
    }
  });

  it('does not wildcard grants across interpreter payloads', () => {
    expect(suggestedCommandPattern("bash -c 'echo safe'")).toBe(
      "bash -c 'echo safe'",
    );
    expect(suggestedCommandPattern("sudo bash -c 'echo safe'")).toBe(
      "sudo bash -c 'echo safe'",
    );
    expect(suggestedCommandPattern("osascript -e 'return 1'")).toBe(
      "osascript -e 'return 1'",
    );
    expect(suggestedCommandPattern('python -m pytest')).toBe(
      'python -m pytest',
    );
    expect(suggestedCommandPattern('python -m pytest')).not.toBe(
      suggestedCommandPattern('python -m attacker_module'),
    );
    expect(
      suggestedCommandPattern('C:\\Windows\\System32\\cmd.exe /c echo hello'),
    ).toBe('C:\\Windows\\System32\\cmd.exe /c echo hello');
    expect(suggestedCommandPattern('npm test')).toBe('npm test *');
    const benignAwk = "awk -F, '{ print $1 }' data.csv";
    const executableAwk = `awk -F, 'BEGIN { system("rm -rf /tmp/data") }'`;
    expect(suggestedCommandPattern(benignAwk)).toBe(benignAwk);
    expect(suggestedCommandPattern(benignAwk)).not.toBe(
      suggestedCommandPattern(executableAwk),
    );
    expect(suggestedCommandPattern('py -c "print(1)"')).toBe(
      'py -c "print(1)"',
    );
    expect(suggestedCommandPattern('py -c "print(1)"')).not.toBe(
      suggestedCommandPattern('py -c "print(2)"'),
    );
    expect(suggestedCommandPattern('   ')).toBe('');
  });

  it('does not wildcard grants across git config overrides', () => {
    expect(suggestedCommandPattern('git -c color.ui=false status')).toBe(
      'git -c color.ui=false status',
    );
    expect(suggestedCommandPattern('sudo git -calias.safe=status safe')).toBe(
      'sudo git -calias.safe=status safe',
    );
    const environmentOverride =
      'env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.safe ' +
      "GIT_CONFIG_VALUE_0='!echo safe' git safe";
    expect(suggestedCommandPattern(environmentOverride)).toBe(
      environmentOverride,
    );
    const configEnvOverride =
      "env SAFE_ALIAS='!echo safe' " +
      'git --config-env=alias.safe=SAFE_ALIAS safe';
    expect(suggestedCommandPattern(configEnvOverride)).toBe(configEnvOverride);
    const configParametersOverride = `env GIT_CONFIG_PARAMETERS="'alias.safe=!echo safe'" git safe`;
    expect(suggestedCommandPattern(configParametersOverride)).toBe(
      configParametersOverride,
    );
  });

  it('does not wildcard Git options whose values are executed', () => {
    for (const command of [
      'git push --receive-pack="sh -c whoami" origin HEAD',
      'git push --exec "sh -c whoami" origin HEAD',
      'git ls-remote --upload-pack="sh -c whoami" origin HEAD',
      'git archive --exec="sh -c whoami" HEAD',
    ]) {
      expect(suggestedCommandPattern(command)).toBe(command);
    }
  });

  it('bounds oversized git config environment counts', () => {
    const command =
      'env GIT_CONFIG_COUNT=999999999999999999999999999999 git status';
    expect(suggestedCommandPattern(command)).toBe(command);
  });

  it('does not wildcard grants across execution wrappers', () => {
    expect(suggestedCommandPattern('arch -arm64 echo ok')).toBe(
      'arch -arm64 echo ok',
    );
    expect(suggestedCommandPattern('env SAFE=1 npm test')).toBe(
      'env SAFE=1 npm test',
    );
  });

  it('does not wildcard grants when global options precede the operation', () => {
    expect(suggestedCommandPattern('git -C /repo status')).toBe(
      'git -C /repo status',
    );
    expect(suggestedCommandPattern('npm --prefix /repo test')).toBe(
      'npm --prefix /repo test',
    );
    expect(suggestedCommandPattern('git -C /repo status')).not.toBe(
      suggestedCommandPattern('git -C /repo reset --hard'),
    );
  });

  it('does not let a benign git submodule approval authorize shell execution', () => {
    const statusCommand = 'git submodule status';
    const rememberedPattern = suggestedCommandPattern(statusCommand);

    expect(rememberedPattern).toBe(statusCommand);
    expect(
      commandPatternMatches(
        rememberedPattern,
        "git submodule foreach 'sh -c whoami'",
      ),
    ).toBe(false);
  });

  it('extracts attached PowerShell path parameters as deletion operands', () => {
    expect(
      recursiveForcedRemoveOperands('Remove-Item -Recurse -Force -Path:C:\\'),
    ).toEqual(['C:\\']);
    expect(
      recursiveForcedRemoveOperands(
        'Remove-Item -Recurse -Force -LiteralPath:~',
      ),
    ).toEqual(['~']);
  });

  it('extracts Windows rd recursive quiet operands', () => {
    expect(recursiveForcedRemoveOperands('rd /s /q C:\\Users\\alice')).toEqual([
      'C:\\Users\\alice',
    ]);
    expect(recursiveForcedRemoveOperands('rmdir /Q/S C:\\')).toEqual(['C:\\']);
    expect(recursiveForcedRemoveOperands('RD /sq C:\\Users')).toEqual([
      'C:\\Users',
    ]);
  });

  it('keeps compound command grants atomic', () => {
    expect(suggestedCommandPattern('npm test && git status')).toBe(
      'npm test && git status',
    );
  });
});

describe('commandPatternMatches', () => {
  it('matches prefix with trailing star', () => {
    expect(commandPatternMatches('npm test *', 'npm test -- --watch')).toBe(
      true,
    );
    expect(commandPatternMatches('npm test *', 'npm test')).toBe(true);
  });
  it('enforces word boundaries', () => {
    expect(commandPatternMatches('ls *', 'lsof')).toBe(false);
    expect(commandPatternMatches('ls *', 'ls -la')).toBe(true);
  });
  it('requires exact tokens without star', () => {
    expect(commandPatternMatches('git status', 'git status')).toBe(true);
    expect(commandPatternMatches('git status', 'git status --short')).toBe(
      false,
    );
  });
  it('matches executable casing only when requested', () => {
    expect(commandPatternMatches('npm publish *', 'NPM publish package')).toBe(
      false,
    );
    expect(
      commandPatternMatches('npm publish *', 'NPM publish package', true),
    ).toBe(true);
  });
  it('handles pathological wildcard patterns in linear time', () => {
    const pattern = 'a*'.repeat(30) + 'b';
    const input = 'a'.repeat(40);
    const start = Date.now();
    expect(commandPatternMatches(pattern, input)).toBe(false);
    expect(Date.now() - start).toBeLessThan(100);
  });
  it('handles pathological file-write glob patterns in linear time', () => {
    const pattern = 'a*'.repeat(30) + 'b';
    const start = Date.now();
    expect(
      ruleMatchesCheck(
        rule({
          behavior: 'allow',
          target: { kind: 'file-write', path: pattern },
        }),
        { kind: 'file-write', path: 'a'.repeat(40) },
      ),
    ).toBe(false);
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe('evaluateApproval', () => {
  it('prompts for an unmatched command in ask mode', () => {
    expect(
      evaluateApproval({ kind: 'command', command: 'npm test' }, ctx()),
    ).toEqual({
      outcome: 'prompt',
    });
  });
  it('allows when an allow rule matches every chain segment', () => {
    const c = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'npm test *' },
          }),
        ],
        project: [
          rule({
            id: 'r2',
            behavior: 'allow',
            target: { kind: 'command', pattern: 'git status' },
          }),
        ],
        global: [],
      },
    });
    const result = evaluateApproval(
      { kind: 'command', command: 'npm test && git status' },
      c,
    );
    expect(result.outcome).toBe('allow');
  });
  it('matches an atomic remembered rule only to the same compound command', () => {
    const atomicRule = rule({
      behavior: 'allow',
      target: {
        kind: 'command',
        pattern: 'npm test && git status',
      },
    });
    const c = ctx({
      rules: {
        session: [atomicRule],
        project: [],
        global: [],
      },
    });

    expect(
      evaluateApproval(
        { kind: 'command', command: 'npm test && git status' },
        c,
      ).outcome,
    ).toBe('allow');
    expect(
      evaluateApproval(
        { kind: 'command', command: 'npm test && git status --short' },
        c,
      ).outcome,
    ).toBe('prompt');
  });
  it('applies an atomic deny only to the same compound command', () => {
    const c = ctx({
      rules: {
        session: [
          rule({
            behavior: 'deny',
            target: {
              kind: 'command',
              pattern: 'npm test && git status',
            },
          }),
        ],
        project: [],
        global: [],
      },
    });

    expect(
      evaluateApproval(
        { kind: 'command', command: 'npm test && git status' },
        c,
      ).outcome,
    ).toBe('deny');
    expect(
      evaluateApproval(
        { kind: 'command', command: 'npm test && git status --short' },
        c,
      ).outcome,
    ).toBe('prompt');
  });
  it('prompts when only some chain segments match allow rules', () => {
    const c = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'npm test *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    expect(
      evaluateApproval({ kind: 'command', command: 'npm test && git push' }, c)
        .outcome,
    ).toBe('prompt');
  });
  it('does not apply wildcard allows to executable-valued Git options', () => {
    const c = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'git push *' },
          }),
          rule({
            id: 'ls-remote-allow',
            behavior: 'allow',
            target: { kind: 'command', pattern: 'git ls-remote *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    for (const command of [
      'git push --receive-pack="sh -c whoami" origin HEAD',
      'git push --exec "sh -c whoami" origin HEAD',
      'git ls-remote --upload-pack="sh -c whoami" origin HEAD',
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, c)).toEqual({
        outcome: 'prompt',
      });
    }
  });
  it('deny beats allow regardless of scope', () => {
    const c = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'git push *' },
          }),
        ],
        project: [],
        global: [
          rule({
            id: 'r2',
            behavior: 'deny',
            target: { kind: 'command', pattern: 'git push *' },
          }),
        ],
      },
    });
    const result = evaluateApproval(
      { kind: 'command', command: 'git push origin dev' },
      c,
    );
    expect(result.outcome).toBe('deny');
  });
  it('safety-denies rm -rf / even with an allow rule, but not in full-access', () => {
    const allowAll = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'rm *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    const denied = evaluateApproval(
      { kind: 'command', command: 'rm -rf /' },
      allowAll,
    );
    expect(denied).toEqual(
      expect.objectContaining({ outcome: 'deny', safety: true }),
    );
    expect(
      evaluateApproval(
        { kind: 'command', command: 'rm -rf /' },
        ctx({ mode: 'full-access' }),
      ).outcome,
    ).toBe('allow');
  });
  it('recognizes PowerShell recursive and force parameters case-insensitively', () => {
    const allowedRm = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'rm *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    expect(
      evaluateApproval(
        { kind: 'command', command: 'rm -Recurse -Force /Users' },
        allowedRm,
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });
  it('prompts for redirections but safety-denies interpreter payloads', () => {
    const allowAll = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'git status *' },
          }),
          rule({
            id: 'r2',
            behavior: 'allow',
            target: { kind: 'command', pattern: 'bash *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    expect(
      evaluateApproval(
        { kind: 'command', command: 'git status > /tmp/status' },
        allowAll,
      ),
    ).toEqual({ outcome: 'prompt' });
    expect(
      evaluateApproval(
        { kind: 'command', command: "bash -c 'rm -rf /'" },
        allowAll,
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    expect(
      evaluateApproval(
        { kind: 'command', command: "sudo bash -c 'rm -rf /'" },
        allowAll,
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    expect(
      evaluateApproval({ kind: 'command', command: 'eval rm -rf /' }, allowAll),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    for (const command of [
      "Invoke-Expression 'Remove-Item -Recurse -Force C:\\\\'",
      "iex 'Remove-Item -Recurse -Force C:\\\\'",
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, allowAll)).toEqual(
        expect.objectContaining({ outcome: 'deny', safety: true }),
      );
    }
  });

  it('safety-denies escaped line continuations before splitting commands', () => {
    const allowFragments = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'r' },
          }),
          rule({
            id: 'r2',
            behavior: 'allow',
            target: { kind: 'command', pattern: 'm -rf *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    expect(
      evaluateApproval(
        { kind: 'command', command: 'r\\\nm -rf /' },
        allowFragments,
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });

  it('canonicalizes dot segments before hard safety matching', () => {
    expect(
      evaluateApproval(
        { kind: 'command', command: 'rm -rf /tmp/../home' },
        ctx(),
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });
  it('safety-denies quoted protected paths before remembered allow rules', () => {
    const allowRm = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'rm -rf *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    for (const command of [
      'rm -rf "/Users"',
      "rm -rf '/Users'",
      'rm -rf "/tmp/../Users"',
      'rm -rf "~/Documents"',
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, allowRm)).toEqual(
        expect.objectContaining({ outcome: 'deny', safety: true }),
      );
    }
  });
  it('safety-denies absolute executable paths before remembered allow rules', () => {
    const allowAbsoluteRm = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: '/bin/rm -rf *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    for (const command of ['/bin/rm -rf /', '"/bin/rm" -rf "/Users"']) {
      expect(
        evaluateApproval({ kind: 'command', command }, allowAbsoluteRm),
      ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    }
  });
  it('safety-denies destructive commands hidden behind wrappers', () => {
    const allowWrapped = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'sudo *' },
          }),
          rule({
            id: 'r2',
            behavior: 'allow',
            target: { kind: 'command', pattern: '/usr/bin/env *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    for (const command of [
      'sudo /bin/rm -rf /',
      'sudo -u root /bin/rm -rf /',
      '/usr/bin/env rm -rf /',
      'env SAFE=1 /bin/rm -rf /',
      'command /bin/rm -rf /',
      'exec /bin/rm -rf /',
      'nice /bin/rm -rf /',
      'nice -n 10 /bin/rm -rf /',
      'nice --adjustment=10 /bin/rm -rf /',
      'time /bin/rm -rf /',
      'time -p /bin/rm -rf /',
      'time -f %E /bin/rm -rf /',
      'time --output=/tmp/timing /bin/rm -rf /',
      'arch -arm64 /bin/rm -rf /',
      'SAFE=1 rm -rf /',
    ]) {
      expect(
        evaluateApproval({ kind: 'command', command }, allowWrapped),
      ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    }
  });
  it('fails closed for commands executed through the macOS script utility', () => {
    const allowScript = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'script -q *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    for (const command of [
      'script -q /dev/null rm -rf /',
      '/usr/bin/script -q /dev/null rm -rf /',
      'sudo /usr/bin/script -q /dev/null rm -rf /',
    ]) {
      expect(
        evaluateApproval({ kind: 'command', command }, allowScript),
      ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    }
  });
  it('applies explicit command denies to commands hidden behind wrappers', () => {
    const denyPublish = ctx({
      rules: {
        session: [
          rule({
            behavior: 'deny',
            target: { kind: 'command', pattern: 'npm publish *' },
          }),
          rule({
            id: 'allow-env',
            behavior: 'allow',
            target: { kind: 'command', pattern: 'env *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    const evaluation = evaluateApproval(
      { kind: 'command', command: 'env FOO=1 npm publish pkg' },
      denyPublish,
    );
    expect(evaluation).toMatchObject({
      outcome: 'deny',
      matchedRule: {
        target: { kind: 'command', pattern: 'npm publish *' },
      },
    });
  });
  it('applies wrapper-specific safety rules before unwrapping', () => {
    const allowSudo = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'sudo *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    expect(
      evaluateApproval(
        { kind: 'command', command: 'sudo rm -rf /tmp/data' },
        allowSudo,
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    for (const command of [
      'sudo -u root rm /etc/passwd',
      'sudo --user=root rm /etc/passwd',
      'sudo -n rm /etc/passwd',
      'sudo -u root /bin/rm /etc/passwd',
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, allowSudo)).toEqual(
        expect.objectContaining({ outcome: 'deny', safety: true }),
      );
    }
  });
  it('safety-denies dangerous commands with extra trailing arguments', () => {
    expect(
      evaluateApproval(
        { kind: 'command', command: 'dd if=/dev/zero of=/dev/sda bs=1M' },
        ctx(),
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    expect(
      evaluateApproval(
        { kind: 'command', command: 'git push --force origin main --tags' },
        ctx(),
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    expect(
      evaluateApproval(
        { kind: 'command', command: 'git push -f origin main' },
        ctx(),
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    for (const command of [
      'git push --force-with-lease origin main',
      'git push --force-with-lease=main:abc123 origin main',
      'git push --force-w origin main',
      'git push --force-w=main:abc123 origin main',
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, ctx())).toEqual(
        expect.objectContaining({ outcome: 'deny', safety: true }),
      );
    }
  });
  it('safety-denies Windows Git force pushes', () => {
    expect(
      evaluateApproval(
        {
          kind: 'command',
          command: 'C:\\Git\\cmd\\git.exe push --force origin main',
        },
        ctx(),
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });
  it('safety-denies raw-device dd writes regardless of operand order or input', () => {
    for (const command of [
      'dd of=/dev/disk0 if=/dev/zero',
      'dd of=/./dev/disk0 if=/dev/zero',
      'dd if=/dev/zero of=//dev/disk0',
      'dd bs=1M of=/dev/disk0',
      'sudo /bin/dd status=progress of=/dev/sda if=/dev/zero',
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, ctx())).toEqual(
        expect.objectContaining({ outcome: 'deny', safety: true }),
      );
    }
  });
  it('does not let a quoted separator rule authorize an executable chain', () => {
    const quotedRule = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: "echo 'ok;./payload'" },
          }),
        ],
        project: [],
        global: [],
      },
    });

    expect(
      evaluateApproval(
        { kind: 'command', command: "echo 'ok;./payload'" },
        quotedRule,
      ),
    ).toEqual(expect.objectContaining({ outcome: 'allow' }));
    expect(
      evaluateApproval(
        { kind: 'command', command: 'echo ok;./payload' },
        quotedRule,
      ),
    ).toEqual(expect.objectContaining({ outcome: 'prompt' }));
  });

  it('preserves empty quoted arguments during command matching', () => {
    expect(commandPatternMatches("printf ''", "printf ''")).toBe(true);
    expect(commandPatternMatches("printf ''", 'printf')).toBe(false);
  });
  it('safety-denies filesystem-specific mkfs helpers', () => {
    for (const command of [
      'mkfs.ext4 /dev/sda',
      '/sbin/mkfs.xfs /dev/sdb',
      'sudo /sbin/mkfs.btrfs /dev/sdc',
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, ctx())).toEqual(
        expect.objectContaining({ outcome: 'deny', safety: true }),
      );
    }
  });
  it('safety-denies destructive busybox and toybox applets', () => {
    for (const command of [
      'busybox rm -rf /',
      'busybox dd if=/dev/zero of=/dev/sda',
      'toybox mkfs.ext4 /dev/sdb',
      'sudo busybox rm -rf /tmp/data',
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, ctx())).toEqual(
        expect.objectContaining({ outcome: 'deny', safety: true }),
      );
    }
  });
  it('keeps multicall applet suggestions exact', () => {
    for (const command of [
      'busybox rm /tmp/file',
      'toybox dd if=input of=output',
    ]) {
      expect(suggestedCommandPattern(command)).toBe(command);
    }
  });
  it('safety-denies force pushes when git global options shift the subcommand', () => {
    const allowGitConfig = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'git -C *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    for (const command of [
      'git -C /repo push --force origin main',
      'git --no-pager -C /repo push -f origin master',
      'sudo /usr/bin/git -C /repo push -vf origin refs/heads/main',
    ]) {
      expect(
        evaluateApproval({ kind: 'command', command }, allowGitConfig),
      ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    }
  });
  it('safety-denies forced refspecs targeting protected branches', () => {
    for (const command of [
      'git push origin +HEAD:main',
      'git push origin +HEAD:refs/heads/master',
      'git push origin +refs/heads/topic:refs/heads/main',
      'git push --force origin HEAD:main',
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, ctx())).toEqual(
        expect.objectContaining({ outcome: 'deny', safety: true }),
      );
    }
  });
  it('safety-denies deletion of protected remote branches', () => {
    const allowGitPush = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'git push *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    for (const command of [
      'git push --delete origin main',
      'git push --del origin main',
      'git push -d origin main',
      'git push -vd origin main',
      'git push origin :main',
    ]) {
      expect(
        evaluateApproval({ kind: 'command', command }, allowGitPush),
      ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    }
  });
  it('safety-denies mirror pushes', () => {
    const allowGitPush = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'git push *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    for (const command of [
      'git push --mirror origin',
      'git push --mir origin',
    ]) {
      expect(
        evaluateApproval({ kind: 'command', command }, allowGitPush),
      ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    }
  });
  it('does not mistake the Git option terminator for a destructive flag', () => {
    expect(
      evaluateApproval(
        { kind: 'command', command: 'git push -- origin topic' },
        ctx(),
      ),
    ).not.toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });
  it('unwraps sudo command-timeout options before safety evaluation', () => {
    const allowSudoTimeout = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'sudo -T *' },
          }),
          rule({
            id: 'sudo-long-timeout',
            behavior: 'allow',
            target: { kind: 'command', pattern: 'sudo --command-timeout*' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    for (const command of [
      'sudo -T 30 rm -rf /tmp/data',
      'sudo --command-timeout 30 rm -rf /tmp/data',
      'sudo --command-timeout=30 rm -rf /tmp/data',
    ]) {
      expect(
        evaluateApproval({ kind: 'command', command }, allowSudoTimeout),
      ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    }
  });
  it('fails closed for force pushes with an implicit destination', () => {
    for (const command of [
      'git push --force',
      'git push --force origin',
      'git push --force origin HEAD',
      'git push -f origin refs/heads/HEAD',
      'git push -f --receive-pack git-receive-pack origin',
      'git push -f --exec git-receive-pack origin',
      'git push -f -o ci.skip origin',
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, ctx())).toEqual(
        expect.objectContaining({ outcome: 'deny', safety: true }),
      );
    }
    expect(
      evaluateApproval(
        { kind: 'command', command: 'git push --force origin topic' },
        ctx(),
      ),
    ).toEqual({ outcome: 'prompt' });
  });
  it('inspects env split-string payloads before applying allow rules', () => {
    const allowEnv = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: '/usr/bin/env *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    for (const command of [
      "/usr/bin/env -S 'rm -rf /'",
      "/usr/bin/env --split-string='rm -rf /'",
      '/usr/bin/env -S rm -rf /',
      "/usr/bin/env -Sbash -c 'rm -rf /'",
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, allowEnv)).toEqual(
        expect.objectContaining({ outcome: 'deny', safety: true }),
      );
    }
  });
  it('skips the env -P utilpath before inspecting the nested command', () => {
    const allowEnv = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: '/usr/bin/env -P *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    expect(
      evaluateApproval(
        {
          kind: 'command',
          command: '/usr/bin/env -P /usr/bin rm -rf ~/*',
        },
        allowEnv,
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });
  it('unwraps clustered wrapper options before safety evaluation', () => {
    const allowWrappers = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'env *' },
          }),
          rule({
            id: 'allow-sudo',
            behavior: 'allow',
            target: { kind: 'command', pattern: 'sudo *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    for (const command of [
      'env -iP /usr/bin rm -rf /',
      'sudo -Hu root rm -rf /',
    ]) {
      expect(
        evaluateApproval({ kind: 'command', command }, allowWrappers),
      ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    }
  });
  it('fails closed for ambiguous clustered wrapper options', () => {
    const allowEnv = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'env *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    for (const command of [
      'env -iZ ignored rm -rf /',
      "env -iS 'rm -rf /'",
      'env -iC / rm -rf .',
      'env -0C / rm -rf .',
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, allowEnv)).toEqual(
        expect.objectContaining({ outcome: 'deny', safety: true }),
      );
    }
  });
  it('fails closed for aliases hidden in git config overrides', () => {
    const allowGitConfig = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'git -c *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    for (const command of [
      "git -c alias.cleanup='!rm -rf ~/*' cleanup",
      "git -calias.cleanup='!rm -rf ~/*' cleanup",
      "git -c 'alias.p=push --force origin main' p",
      "git --no-pager -c color.ui=false -c alias.wipe='!rm -rf ~' wipe",
    ]) {
      expect(
        evaluateApproval({ kind: 'command', command }, allowGitConfig),
      ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    }
  });
  it('fails closed for aliases hidden in Windows Git config overrides', () => {
    expect(
      evaluateApproval(
        {
          kind: 'command',
          command:
            "C:\\Git\\cmd\\git.exe -c alias.cleanup='!rm -rf ~/*' cleanup",
        },
        ctx({
          rules: {
            session: [
              rule({
                behavior: 'allow',
                target: {
                  kind: 'command',
                  pattern: 'C:\\Git\\cmd\\git.exe -c *',
                },
              }),
            ],
            project: [],
            global: [],
          },
        }),
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });
  it('fails closed for aliases supplied through git config environment variables', () => {
    const allowEnv = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'env *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    expect(
      evaluateApproval(
        {
          kind: 'command',
          command:
            'env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x ' +
            "GIT_CONFIG_VALUE_0='!rm -rf ~/*' git x",
        },
        allowEnv,
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });
  it('fails closed for aliases supplied through GIT_CONFIG_PARAMETERS', () => {
    const allowEnv = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'env *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    for (const command of [
      `env GIT_CONFIG_PARAMETERS="'alias.wipe=!rm -rf ~/*'" git wipe`,
      `GIT_CONFIG_PARAMETERS="'alias.wipe'='!rm -rf ~/*'" git wipe`,
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, allowEnv)).toEqual(
        expect.objectContaining({ outcome: 'deny', safety: true }),
      );
    }
  });
  it('fails closed for aliases supplied through git --config-env', () => {
    const allowEnv = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'env *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    for (const command of [
      "env WIPE_ALIAS='!rm -rf ~/*' " +
        'git --config-env=alias.wipe=WIPE_ALIAS wipe',
      "WIPE_ALIAS='!rm -rf ~/*' " +
        'git --config-env alias.wipe=WIPE_ALIAS wipe',
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, allowEnv)).toEqual(
        expect.objectContaining({ outcome: 'deny', safety: true }),
      );
    }
  });
  it('fails closed for mutable Git config selectors', () => {
    const allowEnv = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'env *' },
          }),
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'git *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    for (const command of [
      'git -c include.path=/tmp/agent.gitconfig deploy',
      'git -c includeIf.gitdir:/repo/.path=/tmp/agent.gitconfig deploy',
      'env GIT_CONFIG_GLOBAL=/tmp/agent.gitconfig git deploy',
      'GIT_CONFIG_SYSTEM=/tmp/agent.gitconfig git deploy',
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, allowEnv)).toEqual(
        expect.objectContaining({ outcome: 'deny', safety: true }),
      );
    }
  });
  it('fails closed when env split-string escape semantics cannot be modeled', () => {
    const allowEnv = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: '/usr/bin/env *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    expect(
      evaluateApproval(
        { kind: 'command', command: "/usr/bin/env -S 'rm\\_-rf\\_/'" },
        allowEnv,
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });
  it('fails closed when safety-wrapper unwrapping reaches its depth cap', () => {
    const allowEnv = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'env *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    const command = `${Array.from({ length: 9 }, () => 'env').join(' ')} rm -rf /`;

    expect(evaluateApproval({ kind: 'command', command }, allowEnv)).toEqual(
      expect.objectContaining({ outcome: 'deny', safety: true }),
    );
  });
  it('requires an explicit prompt for unquoted brace expansion', () => {
    const allowRm = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'rm -rf *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    expect(
      evaluateApproval(
        { kind: 'command', command: 'rm -rf {/,/tmp}' },
        allowRm,
      ),
    ).toEqual({ outcome: 'prompt' });
  });
  it('fails closed for shell control structures and function declarations', () => {
    const allowAll = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: '*' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    for (const command of [
      'if true; then rm -rf /; fi',
      'while true; do rm -rf /; done',
      'f(){ rm -rf /; }; f',
      'function f { rm -rf /; }; f',
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, allowAll)).toEqual(
        expect.objectContaining({ outcome: 'deny', safety: true }),
      );
    }
  });
  it('fails closed for commands hidden behind shell negation', () => {
    const allowNegatedRm = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: '! rm *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    expect(
      evaluateApproval(
        { kind: 'command', command: '! rm -rf /' },
        allowNegatedRm,
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });
  it('requires an explicit prompt for commands embedded in find executors', () => {
    const allowFind = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'find *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    expect(
      evaluateApproval(
        {
          kind: 'command',
          command: 'find . -prune -exec rm -rf ~ {} +',
        },
        allowFind,
      ),
    ).toEqual({ outcome: 'prompt' });
  });
  it('requires an explicit prompt for commands embedded in xargs executors', () => {
    const allowXargs = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'echo *' },
          }),
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'xargs *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    expect(
      evaluateApproval(
        {
          kind: 'command',
          command: 'echo ~ | xargs rm -rf',
        },
        allowXargs,
      ),
    ).toEqual({ outcome: 'prompt' });
  });
  it('safety-denies find -delete before remembered allow rules', () => {
    const allowFind = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'find . *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    expect(
      evaluateApproval(
        { kind: 'command', command: 'find . -delete' },
        allowFind,
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });
  it('fails closed when canonical rm operands reach protected roots', () => {
    const allowRm = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'rm -rf *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    expect(
      evaluateApproval(
        {
          kind: 'command',
          command: 'rm -rf root-link/*',
          resolvedPaths: ['/*'],
          protectedRoots: ['/', '/Users/tester'],
        },
        allowRm,
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    expect(
      evaluateApproval(
        {
          kind: 'command',
          command: 'rm -rf dangling-link/*',
          pathResolutionFailed: true,
          protectedRoots: ['/'],
        },
        allowRm,
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });
  it('prompts instead of safety-denying generic path resolution failures', () => {
    expect(
      evaluateApproval(
        {
          kind: 'command',
          command: 'cd ~/repo && npm test',
          pathResolutionFailed: true,
        },
        ctx({ protectedFileWritePaths: ['/ws/approvals.json'] }),
      ),
    ).toEqual({ outcome: 'prompt' });
  });
  it('fails closed when canonical PowerShell Remove-Item operands reach protected roots', () => {
    const cases: Array<readonly [string, string, string, string[]]> = [
      [
        'Remove-Item -Recurse -Force C:\\Users\\tester',
        'Remove-Item -Recurse *',
        'C:\\Users\\tester',
        ['C:\\', 'C:\\Users\\tester'],
      ],
      [
        'C:\\Windows\\System32\\Remove-Item.exe -Recurse -Force C:\\',
        'Remove-Item.exe -Recurse *',
        'C:\\',
        ['C:\\'],
      ],
      ...['ri', 'rmdir', 'rd', 'del', 'erase'].flatMap(
        (alias): Array<[string, string, string, string[]]> => [
          [
            `${alias} -Recurse -Force C:\\`,
            `${alias} -Recurse *`,
            'C:\\',
            ['C:\\'],
          ],
          [
            `C:\\PowerShell\\${alias}.exe -Recurse -Force C:\\Users\\tester`,
            `${alias}.exe -Recurse *`,
            'C:\\Users\\tester',
            ['C:\\', 'C:\\Users\\tester'],
          ],
        ],
      ),
    ];
    for (const [command, pattern, resolvedPath, protectedRoots] of cases) {
      const allowRemoveItem = ctx({
        rules: {
          session: [
            rule({
              behavior: 'allow',
              target: { kind: 'command', pattern },
            }),
          ],
          project: [],
          global: [],
        },
      });
      expect(
        evaluateApproval(
          {
            kind: 'command',
            command,
            resolvedPaths: [resolvedPath],
            protectedRoots: [...protectedRoots],
          },
          allowRemoveItem,
        ),
      ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    }
  });
  it('fails closed on PowerShell array expressions before path parsing', () => {
    const allowRemoveItem = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: {
              kind: 'command',
              pattern: 'Remove-Item -Recurse -Force *',
            },
          }),
        ],
        project: [],
        global: [],
      },
    });

    expect(
      evaluateApproval(
        {
          kind: 'command',
          command: "Remove-Item -Recurse -Force @('C:\\Users\\tester')",
          protectedRoots: ['C:\\', 'C:\\Users\\tester'],
        },
        allowRemoveItem,
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });
  it('fails closed when canonical Windows rd operands reach protected roots', () => {
    for (const command of [
      'rd /s /q C:\\Users\\tester',
      'rmdir /Q/S C:\\',
      'RD /sq C:\\Users',
    ]) {
      const allowRd = ctx({
        rules: {
          session: [
            rule({
              behavior: 'allow',
              target: { kind: 'command', pattern: 'rd /s *' },
            }),
          ],
          project: [],
          global: [],
        },
      });
      expect(
        evaluateApproval(
          {
            kind: 'command',
            command,
            resolvedPaths: [
              command.endsWith('C:\\') ? 'C:\\' : 'C:\\Users\\tester',
            ],
            protectedRoots: ['C:\\', 'C:\\Users\\tester'],
          },
          allowRd,
        ),
      ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    }
  });
  it('safety-denies equivalent home paths with redundant separators', () => {
    const allowRm = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'rm -rf *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    expect(
      evaluateApproval({ kind: 'command', command: 'rm -rf ~//' }, allowRm),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });
  it('safety-denies named-user home paths', () => {
    const allowRm = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'rm -rf *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    for (const command of [
      'rm -rf ~tirish',
      'rm -rf ~tirish/*',
      'rm -rf ~tirish/Documents',
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, allowRm)).toEqual(
        expect.objectContaining({ outcome: 'deny', safety: true }),
      );
    }
  });
  it('safety-denies protected rm targets when extra options are inserted', () => {
    const allowRm = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'rm -rf *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    for (const command of [
      'rm -rf -v ~/*',
      'rm -v -r -f ~/*',
      'rm --recursive --force -- ~/*',
    ]) {
      expect(evaluateApproval({ kind: 'command', command }, allowRm)).toEqual(
        expect.objectContaining({ outcome: 'deny', safety: true }),
      );
    }
  });
  it('does not safety-deny rm -rf of a nested path', () => {
    expect(
      evaluateApproval({ kind: 'command', command: 'rm -rf /tmp/foo' }, ctx())
        .outcome,
    ).toBe('prompt');
  });
  it('safety-denies destructive removal through execution wrappers', () => {
    const wrapperRules = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'nohup rm *' },
          }),
          rule({
            id: 'timeout-rule',
            behavior: 'allow',
            target: { kind: 'command', pattern: 'timeout 5s *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    for (const command of [
      'nohup rm -rf ~/*',
      'nohup.exe rm -rf ~/*',
      'timeout 5s rm -rf ~/*',
      'timeout --signal KILL --kill-after=1s 5s rm -rf ~/*',
      'gtimeout -k 1s 5s rm -rf ~/*',
      'caffeinate -i rm -rf ~/*',
      'caffeinate -i -t 60 rm -rf ~/*',
      'caffeinate -w 123 rm -rf ~/*',
    ]) {
      expect(
        evaluateApproval({ kind: 'command', command }, wrapperRules),
      ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    }
  });
  it('fails closed for nested shell execution outside full access', () => {
    const allowEcho = rule({
      behavior: 'allow',
      target: { kind: 'command', pattern: 'echo *' },
    });
    expect(
      evaluateApproval(
        { kind: 'command', command: 'echo $(rm -rf /)' },
        ctx({
          rules: { session: [allowEcho], project: [], global: [] },
        }),
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
    expect(
      evaluateApproval(
        { kind: 'command', command: 'echo $(rm -rf /)' },
        ctx({
          mode: 'full-access',
          rules: { session: [allowEcho], project: [], global: [] },
        }),
      ).outcome,
    ).toBe('allow');
  });
  it('requires an explicit prompt for shell parameter expansion', () => {
    const allowRm = rule({
      behavior: 'allow',
      target: { kind: 'command', pattern: 'rm *' },
    });
    expect(
      evaluateApproval(
        { kind: 'command', command: 'rm -rf "$HOME"' },
        ctx({
          rules: { session: [allowRm], project: [], global: [] },
        }),
      ),
    ).toEqual({ outcome: 'prompt' });
    expect(
      evaluateApproval(
        { kind: 'command', command: "rm -rf '$HOME'" },
        ctx({
          rules: { session: [allowRm], project: [], global: [] },
        }),
      ).outcome,
    ).toBe('allow');
  });
  it('requires an explicit prompt for shell pathname expansion', () => {
    const allowRm = rule({
      behavior: 'allow',
      target: { kind: 'command', pattern: 'rm *' },
    });
    expect(
      evaluateApproval(
        { kind: 'command', command: 'rm -rf /Users/[t]irish' },
        ctx({
          rules: { session: [allowRm], project: [], global: [] },
        }),
      ),
    ).toEqual({ outcome: 'prompt' });
    expect(
      evaluateApproval(
        { kind: 'command', command: "rm -rf '/Users/[t]irish'" },
        ctx({
          rules: { session: [allowRm], project: [], global: [] },
        }),
      ).outcome,
    ).toBe('allow');
  });
  it('fails closed for ANSI-C quoting outside full access', () => {
    const allowRm = rule({
      behavior: 'allow',
      target: { kind: 'command', pattern: 'rm *' },
    });
    expect(
      evaluateApproval(
        { kind: 'command', command: "rm -rf $'/'" },
        ctx({
          rules: { session: [allowRm], project: [], global: [] },
        }),
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });
  it('applies narrower deny rules to broad authority grants', () => {
    const denyNetwork = rule({
      behavior: 'deny',
      target: { kind: 'network', host: 'secrets.example.com' },
    });
    const denyFile = rule({
      id: 'r2',
      behavior: 'deny',
      target: { kind: 'file-write', path: '/repo/.env' },
    });
    const grantContext = ctx({
      rules: {
        session: [denyNetwork, denyFile],
        project: [],
        global: [],
      },
    });

    expect(
      evaluateApproval(
        { kind: 'network', host: '*', isGrant: true },
        grantContext,
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny' }));
    expect(
      evaluateApproval(
        { kind: 'file-write', path: '/repo/**', isGrant: true },
        grantContext,
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny' }));
  });
  it('full-access allows everything else without rules', () => {
    expect(
      evaluateApproval(
        { kind: 'mcp', server: 'linear', tool: 'delete_issue' },
        ctx({ mode: 'full-access' }),
      ).outcome,
    ).toBe('allow');
  });
  it('auto mode allows project file writes and prompts outside', () => {
    const c = ctx({ mode: 'auto', workspaceRoot: '/ws/repo' });
    expect(
      evaluateApproval({ kind: 'file-write', path: '/ws/repo/src/a.ts' }, c)
        .outcome,
    ).toBe('allow');
    expect(
      evaluateApproval({ kind: 'file-write', path: '/etc/hosts' }, c).outcome,
    ).toBe('prompt');
  });
  it('prompts before writing protected policy files despite Auto or allow rules', () => {
    const protectedPath = '/ws/repo/approvals.json';
    const c = ctx({
      mode: 'auto',
      workspaceRoot: '/ws/repo',
      protectedFileWritePaths: [protectedPath],
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'file-write', path: '/ws/repo/**' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    expect(
      evaluateApproval(
        {
          kind: 'file-write',
          path: protectedPath,
          resolvedPath: protectedPath,
        },
        c,
      ),
    ).toEqual({ outcome: 'prompt' });
    expect(
      evaluateApproval(
        {
          kind: 'file-write',
          path: '/ws/repo/**',
          isGrant: true,
        },
        c,
      ),
    ).toEqual({ outcome: 'prompt' });
    expect(
      evaluateApproval(
        {
          kind: 'file-write',
          path: '/ws/repo/src/**',
          isGrant: true,
        },
        c,
      ).outcome,
    ).toBe('allow');
  });
  it('prompts before command rules can target protected policy files', () => {
    const protectedPath = '/ws/repo/approvals.json';
    const commandContext = ctx({
      protectedFileWritePaths: [protectedPath],
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'cp payload *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    expect(
      evaluateApproval(
        {
          kind: 'command',
          command: `cp payload ${protectedPath}`,
          resolvedPaths: ['/ws/repo/payload', protectedPath],
        },
        commandContext,
      ),
    ).toEqual({ outcome: 'prompt' });
  });
  it('prompts before recursively deleting an ancestor of a policy file', () => {
    const protectedPath = '/Users/test/workspaces/ws/approvals.json';
    const commandContext = ctx({
      protectedFileWritePaths: [protectedPath],
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'rm -rf *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    expect(
      evaluateApproval(
        {
          kind: 'command',
          command: 'rm -rf /Users/test/workspaces/ws',
          resolvedPaths: ['/Users/test/workspaces/ws'],
        },
        commandContext,
      ),
    ).toEqual({ outcome: 'prompt' });
  });
  describe('a protected file-name glob', () => {
    const backups = '/srv/canopy/preferences.backup-*.json';
    const allowAll = (pathCaseInsensitive = false): ApprovalEvaluationContext =>
      ctx({
        protectedFileWritePaths: [backups],
        pathCaseInsensitive,
        rules: {
          session: [
            rule({
              behavior: 'allow',
              target: { kind: 'file-write', path: '/**' },
            }),
            rule({
              behavior: 'allow',
              target: { kind: 'command', pattern: 'rm *' },
            }),
          ],
          project: [],
          global: [],
        },
      });
    const write = (path: string): ApprovalCheck => ({
      kind: 'file-write',
      path,
      resolvedPath: path,
    });
    const remove = (command: string, path: string): ApprovalCheck => ({
      kind: 'command',
      command,
      resolvedPaths: [path],
    });

    it('prompts for every file the glob names, and only those', () => {
      const backup =
        '/srv/canopy/preferences.backup-2026-10-23T00-00-00-000Z.json';
      expect(evaluateApproval(write(backup), allowAll()).outcome).toBe(
        'prompt',
      );
      expect(
        evaluateApproval(
          write('/srv/canopy/preferences.backup-x.json.bak'),
          allowAll(),
        ).outcome,
      ).toBe('allow');
      expect(
        evaluateApproval(
          write('/srv/canopy/nested/preferences.backup-x.json'),
          allowAll(),
        ).outcome,
      ).toBe('allow');
      expect(
        evaluateApproval(write('/srv/canopy/preferences.json'), allowAll())
          .outcome,
      ).toBe('allow');
    });

    it('folds case only where the volume is case-insensitive', () => {
      const upper = '/SRV/Canopy/Preferences.Backup-X.JSON';
      expect(evaluateApproval(write(upper), allowAll(true)).outcome).toBe(
        'prompt',
      );
      expect(evaluateApproval(write(upper), allowAll()).outcome).toBe('allow');
    });

    it('prompts for a command naming a match, or recursively removing its folder', () => {
      expect(
        evaluateApproval(
          remove(
            'rm /srv/canopy/preferences.backup-x.json',
            '/srv/canopy/preferences.backup-x.json',
          ),
          allowAll(),
        ).outcome,
      ).toBe('prompt');
      expect(
        evaluateApproval(
          remove('rm -rf /srv/canopy', '/srv/canopy'),
          allowAll(),
        ).outcome,
      ).toBe('prompt');
      expect(
        evaluateApproval(remove('rm /srv/canopy', '/srv/canopy'), allowAll())
          .outcome,
      ).toBe('allow');
      expect(
        evaluateApproval(
          remove('rm -rf /srv/canopy/nested', '/srv/canopy/nested'),
          allowAll(),
        ).outcome,
      ).toBe('allow');
    });

    it.each([
      ['/srv/canopy/**', 'prompt'],
      ['/srv/canopy', 'prompt'],
      ['/srv/canopy/*.json', 'prompt'],
      ['/srv/canopy/preferences.backup-1.json', 'prompt'],
      ['/**', 'prompt'],
      ['/srv/canopy/nested/**', 'allow'],
      ['/srv/canopy/notes.json', 'allow'],
      ['/elsewhere/**', 'allow'],
    ])('treats a write grant over %s as reaching it: %s', (path, outcome) => {
      expect(
        evaluateApproval(
          { kind: 'file-write', path, isGrant: true },
          allowAll(),
        ).outcome,
      ).toBe(outcome);
    });
  });
  it('safety-denies Windows separators hidden from POSIX parsing', () => {
    expect(
      evaluateApproval(
        {
          kind: 'command',
          command: 'Write-Output safe\\; Remove-Item -Recurse C:\\tmp',
          shellPlatform: 'windows',
        },
        ctx({
          rules: {
            session: [
              rule({
                behavior: 'allow',
                target: { kind: 'command', pattern: 'Write-Output *' },
              }),
            ],
            project: [],
            global: [],
          },
        }),
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });
  it('applies deny rules to Windows command segments in full access', () => {
    expect(
      evaluateApproval(
        {
          kind: 'command',
          command: String.raw`Write-Output safe\; Remove-Item secret.txt`,
          shellPlatform: 'windows',
        },
        ctx({
          mode: 'full-access',
          rules: {
            session: [
              rule({
                behavior: 'deny',
                target: { kind: 'command', pattern: 'Remove-Item *' },
              }),
            ],
            project: [],
            global: [],
          },
        }),
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny' }));
  });

  it('prompts for cmd modifier expansions under remembered command rules', () => {
    const commandContext = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'rd /s *' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    for (const command of [
      'rd /s /q %USERPROFILE:~0%',
      'rd /s /q %USERPROFILE:Users=Temp%',
    ]) {
      expect(
        evaluateApproval(
          { kind: 'command', command, shellPlatform: 'windows' },
          commandContext,
        ),
      ).toEqual({ outcome: 'prompt' });
    }
  });
  it('prompts before remembered allows for Windows runtime expansions', () => {
    const expansionContext = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'Write-Output *' },
          }),
          rule({
            behavior: 'allow',
            target: { kind: 'command', pattern: 'rd /s /q *' },
          }),
        ],
        project: [],
        global: [],
      },
    });

    for (const command of [
      String.raw`Write-Output C:\tmp\$env:USERPROFILE`,
      String.raw`Write-Output C:\repo\*`,
      'rd /s /q %USERPROFILE%',
      'rd /s /q "%USERPROFILE%"',
      String.raw`type C:\tmp\input > output.txt`,
    ]) {
      expect(
        evaluateApproval(
          { kind: 'command', command, shellPlatform: 'windows' },
          expansionContext,
        ),
      ).toEqual({ outcome: 'prompt' });
    }
  });
  it('safety-denies PowerShell control blocks before remembered rules', () => {
    expect(
      evaluateApproval(
        {
          kind: 'command',
          command:
            'TrY { Write-Output safe } FiNaLlY { Remove-Item -Recurse -Force C:\\Users\\tester }',
          shellPlatform: 'windows',
        },
        ctx({
          rules: {
            session: [
              rule({
                behavior: 'allow',
                target: { kind: 'command', pattern: 'TrY *' },
              }),
            ],
            project: [],
            global: [],
          },
        }),
      ),
    ).toEqual(expect.objectContaining({ outcome: 'deny', safety: true }));
  });
  it('normalizes traversal and Windows path boundaries in auto mode', () => {
    expect(
      evaluateApproval(
        { kind: 'file-write', path: '/ws/repo/../outside/file.ts' },
        ctx({ mode: 'auto', workspaceRoot: '/ws/repo' }),
      ).outcome,
    ).toBe('prompt');
    expect(
      evaluateApproval(
        { kind: 'file-write', path: 'C:\\Repo\\src\\a.ts' },
        ctx({ mode: 'auto', workspaceRoot: 'c:\\repo' }),
      ).outcome,
    ).toBe('allow');
    expect(
      evaluateApproval(
        { kind: 'file-write', path: 'C:\\Repo\\..\\outside\\a.ts' },
        ctx({ mode: 'auto', workspaceRoot: 'C:\\Repo' }),
      ).outcome,
    ).toBe('prompt');
    expect(
      evaluateApproval(
        { kind: 'file-write', path: '/ws/repo\\src/a.ts' },
        ctx({ mode: 'auto', workspaceRoot: '/ws/repo' }),
      ).outcome,
    ).toBe('prompt');
  });

  it('uses a canonical file path for containment and rule matching', () => {
    const c = ctx({
      mode: 'auto',
      workspaceRoot: '/real/workspace',
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'file-write', path: '/real/workspace/**' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    expect(
      evaluateApproval(
        {
          kind: 'file-write',
          path: '/real/workspace/link/file.ts',
          resolvedPath: '/outside/file.ts',
        },
        c,
      ).outcome,
    ).toBe('prompt');
  });
  it('resolves workspace-relative file rules against canonical paths', () => {
    const relativeAllow = rule({
      behavior: 'allow',
      target: { kind: 'file-write', path: 'src/**' },
    });
    expect(
      evaluateApproval(
        {
          kind: 'file-write',
          path: 'src/a.ts',
          resolvedPath: '/real/workspace/src/a.ts',
        },
        ctx({
          workspaceRoot: '/real/workspace',
          rules: { session: [relativeAllow], project: [], global: [] },
        }),
      ).outcome,
    ).toBe('allow');
    expect(
      evaluateApproval(
        {
          kind: 'file-write',
          path: 'src/link/a.ts',
          resolvedPath: '/outside/a.ts',
        },
        ctx({
          workspaceRoot: '/real/workspace',
          rules: { session: [relativeAllow], project: [], global: [] },
        }),
      ).outcome,
    ).toBe('prompt');
  });

  it('applies workspace-relative deny rules before Auto fallback', () => {
    const relativeDeny = rule({
      behavior: 'deny',
      target: { kind: 'file-write', path: 'src/private/**' },
    });
    expect(
      evaluateApproval(
        {
          kind: 'file-write',
          path: 'src/private/key.ts',
          resolvedPath: '/real/workspace/src/private/key.ts',
        },
        ctx({
          mode: 'auto',
          workspaceRoot: '/real/workspace',
          rules: { session: [relativeDeny], project: [], global: [] },
        }),
      ).outcome,
    ).toBe('deny');
  });
  it('matches file deny rules against lexical and canonical paths', () => {
    const denyLexicalLink = rule({
      behavior: 'deny',
      target: { kind: 'file-write', path: 'src/link/**' },
    });
    const check = {
      kind: 'file-write' as const,
      path: 'src/link/key.ts',
      resolvedPath: '/outside/key.ts',
    };
    const rules = {
      session: [denyLexicalLink],
      project: [],
      global: [],
    };

    expect(
      evaluateApproval(
        check,
        ctx({ mode: 'auto', workspaceRoot: '/repo', rules }),
      ).outcome,
    ).toBe('deny');

    expect(
      evaluateApproval(check, {
        ...ctx({
          mode: 'auto',
          workspaceRoot: '/repo',
          rules: {
            session: [
              rule({
                behavior: 'allow',
                target: { kind: 'file-write', path: 'src/link/**' },
              }),
            ],
            project: [],
            global: [],
          },
        }),
      }).outcome,
    ).toBe('prompt');
  });
  it('matches file rules case-insensitively when the filesystem requires it', () => {
    const relativeDeny = rule({
      behavior: 'deny',
      target: { kind: 'file-write', path: 'src/nonexistent-secret.txt' },
    });
    const check = {
      kind: 'file-write' as const,
      path: 'SRC/NONEXISTENT-SECRET.TXT',
      resolvedPath: '/real/workspace/SRC/NONEXISTENT-SECRET.TXT',
    };
    const rules = { session: [relativeDeny], project: [], global: [] };

    expect(
      evaluateApproval(check, {
        ...ctx({ mode: 'auto', workspaceRoot: '/real/workspace', rules }),
        pathCaseInsensitive: true,
      }).outcome,
    ).toBe('deny');
    expect(
      evaluateApproval(check, {
        ...ctx({ mode: 'auto', workspaceRoot: '/real/workspace', rules }),
        pathCaseInsensitive: false,
      }).outcome,
    ).toBe('allow');
  });
  it('matches command executable casing when the filesystem requires it', () => {
    const denyPublish = rule({
      behavior: 'deny',
      target: { kind: 'command', pattern: 'npm publish *' },
    });
    const rules = { session: [denyPublish], project: [], global: [] };
    const check = {
      kind: 'command' as const,
      command: 'NPM publish package',
    };

    expect(
      evaluateApproval(check, {
        ...ctx({ mode: 'full-access', rules }),
        pathCaseInsensitive: true,
      }).outcome,
    ).toBe('deny');
    expect(
      evaluateApproval(check, {
        ...ctx({ mode: 'full-access', rules }),
        pathCaseInsensitive: false,
      }).outcome,
    ).toBe('allow');
  });
  it('matches mcp rules at server and tool level', () => {
    const serverWide = ctx({
      rules: {
        session: [],
        project: [
          rule({
            behavior: 'allow',
            target: { kind: 'mcp', server: 'linear' },
          }),
        ],
        global: [],
      },
    });
    expect(
      evaluateApproval(
        { kind: 'mcp', server: 'linear', tool: 'save_issue' },
        serverWide,
      ).outcome,
    ).toBe('allow');
    expect(
      evaluateApproval(
        { kind: 'mcp', server: 'github', tool: 'save_issue' },
        serverWide,
      ).outcome,
    ).toBe('prompt');
  });
  it('matches network wildcard hosts', () => {
    const c = ctx({
      rules: {
        session: [
          rule({
            behavior: 'allow',
            target: { kind: 'network', host: '*.example.com' },
          }),
        ],
        project: [],
        global: [],
      },
    });
    expect(
      evaluateApproval({ kind: 'network', host: 'api.example.com' }, c).outcome,
    ).toBe('allow');
    expect(
      evaluateApproval({ kind: 'network', host: 'example.org' }, c).outcome,
    ).toBe('prompt');
  });
  it('matches network hosts case-insensitively', () => {
    const denySecret = rule({
      behavior: 'deny',
      target: { kind: 'network', host: 'secrets.example.com' },
    });
    const allowDomain = rule({
      id: 'allow-domain',
      behavior: 'allow',
      target: { kind: 'network', host: '*.example.com' },
    });
    expect(
      evaluateApproval(
        { kind: 'network', host: 'SeCrEtS.Example.COM' },
        ctx({
          rules: {
            session: [allowDomain],
            project: [denySecret],
            global: [],
          },
        }),
      ).outcome,
    ).toBe('deny');
  });
  it('matches DNS hosts with or without a trailing root dot', () => {
    const denySecret = rule({
      behavior: 'deny',
      target: { kind: 'network', host: 'secrets.example.com' },
    });
    const allowDomain = rule({
      id: 'allow-domain',
      behavior: 'allow',
      target: { kind: 'network', host: '*.example.com.' },
    });
    const rules = {
      session: [allowDomain],
      project: [denySecret],
      global: [],
    };

    expect(
      evaluateApproval(
        { kind: 'network', host: 'secrets.example.com.' },
        ctx({ rules }),
      ).outcome,
    ).toBe('deny');
    expect(
      evaluateApproval(
        { kind: 'network', host: 'api.example.com' },
        ctx({ rules }),
      ).outcome,
    ).toBe('allow');
  });
});

describe('ruleMatchesCheck', () => {
  it('matches a command rule against a fully covered command check', () => {
    expect(
      ruleMatchesCheck(
        rule({
          behavior: 'allow',
          target: { kind: 'command', pattern: 'npm test *' },
        }),
        { kind: 'command', command: 'npm test -- --watch' },
      ),
    ).toBe(true);
    expect(
      ruleMatchesCheck(
        rule({
          behavior: 'allow',
          target: { kind: 'command', pattern: 'npm test *' },
        }),
        { kind: 'command', command: 'npm test && git push' },
      ),
    ).toBe(false);
  });
  it('matches a file-write rule via glob semantics', () => {
    expect(
      ruleMatchesCheck(
        rule({
          behavior: 'allow',
          target: { kind: 'file-write', path: 'src/**' },
        }),
        { kind: 'file-write', path: 'src/a/b.ts' },
      ),
    ).toBe(true);
    expect(
      ruleMatchesCheck(
        rule({
          behavior: 'allow',
          target: { kind: 'file-write', path: 'src/*.ts' },
        }),
        { kind: 'file-write', path: 'src/a/b.ts' },
      ),
    ).toBe(false);
  });
  it('matches an mcp rule at server and tool level', () => {
    expect(
      ruleMatchesCheck(
        rule({
          behavior: 'allow',
          target: { kind: 'mcp', server: 'linear', tool: 'save_issue' },
        }),
        { kind: 'mcp', server: 'linear', tool: 'save_issue' },
      ),
    ).toBe(true);
    expect(
      ruleMatchesCheck(
        rule({
          behavior: 'allow',
          target: { kind: 'mcp', server: 'linear', tool: 'save_issue' },
        }),
        { kind: 'mcp', server: 'linear', tool: 'delete_issue' },
      ),
    ).toBe(false);
  });
  it('matches a network rule with a wildcard host', () => {
    expect(
      ruleMatchesCheck(
        rule({
          behavior: 'allow',
          target: { kind: 'network', host: '*.example.com' },
        }),
        { kind: 'network', host: 'api.example.com' },
      ),
    ).toBe(true);
  });
  it('matches a tool rule by exact name', () => {
    expect(
      ruleMatchesCheck(
        rule({
          behavior: 'allow',
          target: { kind: 'tool', toolName: 'WebSearch' },
        }),
        { kind: 'tool', toolName: 'WebSearch' },
      ),
    ).toBe(true);
    expect(
      ruleMatchesCheck(
        rule({
          behavior: 'allow',
          target: { kind: 'tool', toolName: 'WebSearch' },
        }),
        { kind: 'tool', toolName: 'WebFetch' },
      ),
    ).toBe(false);
  });

  describe('rules saved before the Agent Ledger tools took the Feed names', () => {
    const feedTool = CANOPY_INJECTED_TOOL_REGISTRY.add_ledger_entry;
    const beforeRename = (toolName: string): string =>
      toolName
        .replace(/AddFeedEntry$/, 'AddLedgerEntry')
        .replace(/add_feed_entry$/, 'add_ledger_entry');
    const mcpTarget = (
      claudeToolName: string,
    ): { kind: 'mcp'; server: string; tool: string } => {
      const [, server = '', tool = ''] =
        /^mcp__(.+)__(.+)$/.exec(claudeToolName) ?? [];
      return { kind: 'mcp', server, tool };
    };

    it('keeps a deny rule saved under the old Codex name blocking the tool', () => {
      const saved = rule({
        behavior: 'deny',
        target: {
          kind: 'tool',
          toolName: beforeRename(feedTool.codexToolName),
        },
      });
      expect(saved.target).not.toEqual({
        kind: 'tool',
        toolName: feedTool.codexToolName,
      });
      expect(
        ruleMatchesCheck(saved, {
          kind: 'tool',
          toolName: feedTool.codexToolName,
        }),
      ).toBe(true);
    });

    it('keeps a deny rule saved under the old Claude name blocking the tool', () => {
      const current = mcpTarget(feedTool.claudeToolName);
      const saved = rule({
        behavior: 'deny',
        target: { ...current, tool: beforeRename(current.tool) },
      });
      expect(saved.target).not.toEqual(current);
      expect(ruleMatchesCheck(saved, current)).toBe(true);
    });

    it('keeps old App Advisor and Cursor rules matching their tools', () => {
      const advisor = getAppAdvisorLedgerToolNames('codex').add;
      expect(
        ruleMatchesCheck(
          rule({
            behavior: 'deny',
            target: { kind: 'tool', toolName: beforeRename(advisor) },
          }),
          { kind: 'tool', toolName: advisor },
        ),
      ).toBe(true);
      const advisorMcp = mcpTarget(getAppAdvisorLedgerToolNames('claude').add);
      expect(
        ruleMatchesCheck(
          rule({
            behavior: 'deny',
            target: { ...advisorMcp, tool: beforeRename(advisorMcp.tool) },
          }),
          advisorMcp,
        ),
      ).toBe(true);
      expect(
        ruleMatchesCheck(
          rule({
            behavior: 'deny',
            target: {
              kind: 'tool',
              toolName: beforeRename(feedTool.cursorToolName),
            },
          }),
          { kind: 'tool', toolName: feedTool.cursorToolName },
        ),
      ).toBe(true);
    });

    it('lets an old deny rule override a session allow for the new name', () => {
      const check = { kind: 'tool', toolName: feedTool.codexToolName } as const;
      expect(
        evaluateApproval(
          check,
          ctx({
            mode: 'auto',
            rules: {
              session: [rule({ behavior: 'allow', target: check })],
              project: [],
              global: [
                rule({
                  id: 'saved-deny',
                  behavior: 'deny',
                  target: {
                    kind: 'tool',
                    toolName: beforeRename(feedTool.codexToolName),
                  },
                }),
              ],
            },
          }),
        ),
      ).toEqual(expect.objectContaining({ outcome: 'deny' }));
    });

    it('does not join another server or an unrelated tool to the rename', () => {
      const current = mcpTarget(feedTool.claudeToolName);
      // The same pair of tool names on a server that is not the app's.
      expect(
        ruleMatchesCheck(
          rule({
            behavior: 'deny',
            target: {
              kind: 'mcp',
              server: 'accounting',
              tool: beforeRename(current.tool),
            },
          }),
          { kind: 'mcp', server: 'accounting', tool: current.tool },
        ),
      ).toBe(false);
      // An old name of one tool does not match a different tool.
      expect(
        ruleMatchesCheck(
          rule({
            behavior: 'deny',
            target: {
              kind: 'tool',
              toolName: beforeRename(feedTool.codexToolName),
            },
          }),
          {
            kind: 'tool',
            toolName:
              CANOPY_INJECTED_TOOL_REGISTRY.update_ledger_entry.codexToolName,
          },
        ),
      ).toBe(false);
      expect(
        ruleMatchesCheck(
          rule({
            behavior: 'deny',
            target: { kind: 'tool', toolName: 'vendor_add_ledger_entry' },
          }),
          { kind: 'tool', toolName: 'vendor_add_feed_entry' },
        ),
      ).toBe(false);
    });
  });
});

describe('normalizeApprovalRules', () => {
  it('drops invalid entries and keeps valid ones', () => {
    const input: unknown = [
      {
        id: 'a',
        behavior: 'allow',
        target: { kind: 'tool', toolName: 'WebSearch' },
        createdAt: 'x',
        origin: 'prompt',
      },
      { behavior: 'nope', target: {} },
      'garbage',
    ];
    const rules = normalizeApprovalRules(input);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.target).toEqual({ kind: 'tool', toolName: 'WebSearch' });
  });
});

describe('isApprovalMode', () => {
  it('accepts the three modes and rejects others', () => {
    expect(isApprovalMode('ask')).toBe(true);
    expect(isApprovalMode('auto')).toBe(true);
    expect(isApprovalMode('full-access')).toBe(true);
    expect(isApprovalMode('bypassPermissions')).toBe(false);
  });
});

describe('browser-upload checks', () => {
  const upload = (
    ...displayPaths: string[]
  ): Extract<
    Parameters<typeof evaluateApproval>[0],
    { kind: 'browser-upload' }
  > => ({
    kind: 'browser-upload',
    origin: 'https://upload.example',
    topOrigin: 'https://app.example',
    files: displayPaths.map((displayPath) => ({ displayPath, sizeBytes: 4 })),
  });
  const uploadFromOrigin = (
    origin: string,
    ...displayPaths: string[]
  ): Extract<
    Parameters<typeof evaluateApproval>[0],
    { kind: 'browser-upload' }
  > => ({
    ...upload(...displayPaths),
    origin,
  });

  it('prompts in every mode when no rule matches, including Full Access', () => {
    for (const mode of ['ask', 'auto', 'full-access'] as const) {
      expect(
        evaluateApproval(
          upload('report.csv'),
          ctx({ mode, workspaceRoot: '/w' }),
        ),
      ).toEqual({ outcome: 'prompt' });
    }
  });

  it('allows by an origin rule, in any case, and never for another origin', () => {
    const allow = rule({
      behavior: 'allow',
      target: { kind: 'browser-upload', origin: 'HTTPS://upload.example' },
    });
    const rules = { session: [allow], project: [], global: [] };
    expect(evaluateApproval(upload('report.csv'), ctx({ rules }))).toEqual({
      outcome: 'allow',
      matchedRule: allow,
    });
    expect(
      evaluateApproval(
        uploadFromOrigin('https://upload.example.evil', 'report.csv'),
        ctx({ rules, mode: 'full-access' }),
      ),
    ).toEqual({ outcome: 'prompt' });
  });

  it('allows by a path rule only when every file matches, and denies when any does', () => {
    const allow = rule({
      behavior: 'allow',
      target: {
        kind: 'browser-upload',
        origin: 'https://upload.example',
        path: 'exports/**',
      },
    });
    const allowRules = { session: [allow], project: [], global: [] };
    expect(
      evaluateApproval(
        upload('exports/a.csv', 'exports/b/c.csv'),
        ctx({ rules: allowRules }),
      ).outcome,
    ).toBe('allow');
    expect(
      evaluateApproval(
        upload('exports/a.csv', 'secrets.env'),
        ctx({ rules: allowRules }),
      ).outcome,
    ).toBe('prompt');

    const deny = rule({
      behavior: 'deny',
      target: {
        kind: 'browser-upload',
        origin: 'https://upload.example',
        path: '*.env',
      },
    });
    const denyRules = { session: [allow], project: [deny], global: [] };
    expect(
      evaluateApproval(
        upload('exports/a.csv', 'secrets.env'),
        ctx({ rules: denyRules }),
      ),
    ).toEqual({ outcome: 'deny', matchedRule: deny });
  });

  it('denies by the file itself or the link it was asked for by, and ignores case where the filesystem does', () => {
    const allow = rule({
      behavior: 'allow',
      target: { kind: 'browser-upload', origin: 'https://upload.example' },
    });
    const denySecrets = rule({
      id: 'r2',
      behavior: 'deny',
      target: {
        kind: 'browser-upload',
        origin: 'https://upload.example',
        path: 'secrets/**',
      },
    });
    const linked: Parameters<typeof evaluateApproval>[0] = {
      kind: 'browser-upload',
      origin: 'https://upload.example',
      topOrigin: 'https://upload.example',
      files: [
        {
          displayPath: 'secrets/key.pem',
          requestedPath: 'public/k',
          sizeBytes: 4,
        },
      ],
    };
    const rules = { session: [allow], project: [denySecrets], global: [] };
    // A link into a denied folder is denied by the file it leads to.
    expect(evaluateApproval(linked, ctx({ rules }))).toEqual({
      outcome: 'deny',
      matchedRule: denySecrets,
    });
    // A deny on the link's own path covers it too.
    const denyPublic = rule({
      id: 'r3',
      behavior: 'deny',
      target: {
        kind: 'browser-upload',
        origin: 'https://upload.example',
        path: 'public/**',
      },
    });
    expect(
      evaluateApproval(
        linked,
        ctx({ rules: { session: [allow], project: [denyPublic], global: [] } }),
      ),
    ).toEqual({ outcome: 'deny', matchedRule: denyPublic });
    // Another case of a denied path.
    const cased = {
      ...linked,
      files: [{ displayPath: 'Secrets/key.pem', sizeBytes: 4 }],
    };
    expect(
      evaluateApproval(cased, ctx({ rules, pathCaseInsensitive: true })),
    ).toEqual({ outcome: 'deny', matchedRule: denySecrets });
    expect(evaluateApproval(cased, ctx({ rules })).outcome).toBe('allow');
    // An allow by path also ignores case there, and follows the file itself.
    const allowExports = rule({
      behavior: 'allow',
      target: {
        kind: 'browser-upload',
        origin: 'https://upload.example',
        path: 'exports/**',
      },
    });
    const exportsRules = { session: [allowExports], project: [], global: [] };
    expect(
      evaluateApproval(
        { ...linked, files: [{ displayPath: 'Exports/a.csv', sizeBytes: 1 }] },
        ctx({ rules: exportsRules, pathCaseInsensitive: true }),
      ).outcome,
    ).toBe('allow');
    expect(
      evaluateApproval(
        {
          ...linked,
          files: [
            {
              displayPath: 'secrets/a.csv',
              requestedPath: 'exports/a.csv',
              sizeBytes: 1,
            },
          ],
        },
        ctx({ rules: exportsRules }),
      ).outcome,
    ).toBe('prompt');
  });

  it('denies by an origin rule before any allow rule', () => {
    const allow = rule({
      behavior: 'allow',
      target: { kind: 'browser-upload', origin: 'https://upload.example' },
    });
    const deny = rule({
      id: 'r2',
      behavior: 'deny',
      origin: 'canopy-json',
      target: { kind: 'browser-upload', origin: 'https://upload.example' },
    });
    expect(
      evaluateApproval(
        upload('report.csv'),
        ctx({ rules: { session: [allow], project: [deny], global: [] } }),
      ),
    ).toEqual({ outcome: 'deny', matchedRule: deny });
  });

  it('is not matched by rules of another kind', () => {
    const rules = {
      session: [
        rule({
          behavior: 'allow',
          target: { kind: 'network', host: 'upload.example' },
        }),
        rule({ behavior: 'allow', target: { kind: 'file-write', path: '**' } }),
      ],
      project: [],
      global: [],
    };
    expect(
      evaluateApproval(
        upload('report.csv'),
        ctx({ rules, mode: 'full-access' }),
      ),
    ).toEqual({ outcome: 'prompt' });
  });

  it('normalizes persisted rules, dropping malformed ones individually', () => {
    expect(
      normalizeApprovalRules([
        rule({
          behavior: 'allow',
          target: { kind: 'browser-upload', origin: 'https://upload.example' },
        }),
        {
          ...rule({
            behavior: 'deny',
            target: { kind: 'tool', toolName: 'x' },
          }),
          target: {
            kind: 'browser-upload',
            origin: 'https://a.example',
            path: 'x/*',
          },
        },
        {
          ...rule({
            behavior: 'allow',
            target: { kind: 'tool', toolName: 'x' },
          }),
          target: { kind: 'browser-upload' },
        },
        {
          ...rule({
            behavior: 'allow',
            target: { kind: 'tool', toolName: 'x' },
          }),
          target: {
            kind: 'browser-upload',
            origin: 'https://a.example',
            path: 3,
          },
        },
      ]).map((entry) => entry.target),
    ).toEqual([
      { kind: 'browser-upload', origin: 'https://upload.example' },
      { kind: 'browser-upload', origin: 'https://a.example', path: 'x/*' },
    ]);
  });
});

describe('browser-file-request checks', () => {
  const request: Parameters<typeof evaluateApproval>[0] = {
    kind: 'browser-file-request',
    origin: 'https://upload.example',
    topOrigin: 'https://app.example',
    multiple: false,
  };

  it('asks in every mode, and no rule answers it', () => {
    const rules = {
      session: [
        rule({
          behavior: 'allow',
          target: { kind: 'browser-upload', origin: 'https://upload.example' },
        }),
      ],
      project: [
        rule({ behavior: 'allow', target: { kind: 'tool', toolName: 'Bash' } }),
      ],
      global: [
        rule({
          behavior: 'deny',
          target: { kind: 'browser-upload', origin: 'https://upload.example' },
        }),
      ],
    };
    for (const mode of ['ask', 'auto', 'full-access'] as const) {
      expect(
        evaluateApproval(request, ctx({ mode, rules, workspaceRoot: '/w' })),
      ).toEqual({ outcome: 'prompt' });
    }
  });
});
