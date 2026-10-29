// Static-reading findings about the pinned CLI 2.1.284 (.cache/bin/darwin-arm64/claude,
// a Bun-compiled executable that embeds its JavaScript). Each entry quotes the
// embedded source that supports it. These are NOT runtime observations; the
// report marks them `static-reading-only` and the runtime variants confirm or
// contradict them. Byte offsets apply only to this exact binary.
export const STATIC_FINDINGS = Object.freeze([
  {
    id: 'managed-claude-md-not-gated-by-setting-sources',
    claim:
      'The memory-file collector loads the Managed CLAUDE.md (<managed dir>/CLAUDE.md; macOS /Library/Application Support/ClaudeCode), ' +
      'the managed rules directory and policySettings.claudeMd unconditionally; only User (lr("userSettings")), Project (gv("projectSettings")) ' +
      'and Local (gv("localSettings")) are gated by settingSources. Only CLAUDE_CODE_DISABLE_CLAUDE_MDS (or --bare / safe mode, or a remote session) suppresses it.',
    evidence:
      'Pe=lr("userSettings"),We=gv("projectSettings"),He=gv("localSettings") ... F.push(...await tn(Te,"Managed")) ... he("policySettings")?.claudeMd -> type:"Managed"; if(Pe){...type "User"...}',
    offset: 185445040,
    status: 'static-reading-only',
    consequence:
      'close.claude-md-managed cannot pass with settingSources: [] alone if a managed file exists; the env switch (variant C) is the candidate control.',
  },
  {
    id: 'disable-claude-mds-effect',
    claim:
      'CLAUDE_CODE_DISABLE_CLAUDE_MDS makes the user/project/nested memory loaders return [] and FH() true; it is also set automatically in CLAUDE_CODE_SAFE_MODE.',
    evidence:
      'async function Ret(e,n,r){if(a.CLAUDE_CODE_DISABLE_CLAUDE_MDS)return[]...} async function VLn(...){if(a.CLAUDE_CODE_DISABLE_CLAUDE_MDS)return[]...} function FH(){return Boolean(a.CLAUDE_CODE_DISABLE_CLAUDE_MDS||jr("claudeMd",...))}',
    offset: 185451041,
    status: 'static-reading-only',
  },
  {
    id: 'bare-mode-candidate',
    claim:
      '`--bare` (CLAUDE_CODE_SIMPLE=1) turns claudeMd, skills, plugins, hooks, agents, mcpAutoDiscovered, outputStyles and keybindings off in one switch (table t in the settings-gating module). Not exercised by this probe; a follow-up candidate.',
    evidence:
      'var t={claudeMd:!0,skills:!0,...,plugins:!0,hooks:!0,...}; if(o.bare)process.env.CLAUDE_CODE_SIMPLE="1"',
    offset: 182700845,
    status: 'static-reading-only',
  },
  {
    id: 'attachments-switch',
    claim:
      'A CLAUDE_CODE_DISABLE_ATTACHMENTS environment switch exists (attachment gating expression includes CLAUDE_CODE_SIMPLE || CLAUDE_CODE_DISABLE_ATTACHMENTS). Not applied in this probe; a candidate if the between-tool pass injects content.',
    evidence:
      '...SIMPLE||a.CLAUDE_CODE_DISABLE_ATTACHMENTS)}function ohe(){...keptDeferredToolsEnabled...',
    offset: 183709901,
    status: 'static-reading-only',
  },
  {
    id: 'keychain-access-paths',
    claim:
      'The CLI reads credentials through `security find-generic-password -a <user> -w -s <service>` (keychain storage backend, "Failed to read API key from macOS keychain"), ' +
      'and a device-key store also calls `security`. Whether any of these run when ANTHROPIC_API_KEY is set was NOT determined statically. The probe therefore puts a recorder named `security` first on PATH ' +
      '(exit 44 = item not found) so every attempt is logged and refused; apiKeySource from init is recorded.',
    evidence:
      'On={name:"keychain",...read(){...OSSe(`security find-generic-password -a "${o}" -w -s "${s}"`...)}}; "[deviceKeyStore] this account has no login keychain (security exited "',
    offset: 179598999,
    status: 'static-reading-only',
  },
  {
    id: 'auto-memory-location',
    claim:
      'Auto-memory index path is <CLAUDE_CONFIG_DIR>/projects/<cwd with non-alphanumerics replaced by ->/memory/MEMORY.md; CLAUDE_CODE_DISABLE_AUTO_MEMORY disables it (the production restricted builder sets it; the probe removes it so the memory fixture can be live).',
    evidence:
      'var Yb="memory",BN="MEMORY.md"; function J7(){return Er(Ns(),BN)}; disabled_by_env_var for CLAUDE_CODE_DISABLE_AUTO_MEMORY',
    offset: 180251065,
    status: 'static-reading-only',
  },
  {
    id: 'agents-skills-dir-is-import-source',
    claim:
      '~/.agents/skills appears only in the foreign-tool import tables (Cursor/Gemini auto-import hints), not as a native discovery root; the skillAgentsDir control result decides.',
    evidence:
      '"~/.cursor/skills" ... "~/.agents/skills" ... "Not yet auto-imported; append it to ~/.claude/CLAUDE.md"',
    offset: 75866854,
    status: 'static-reading-only',
  },
  {
    id: 'proxy-env-handling',
    claim:
      'The embedded runtime reads HTTP_PROXY/HTTPS_PROXY/ALL_PROXY and NO_PROXY (either case). That NO_PROXY is honored for the loopback ANTHROPIC_BASE_URL is verified only at runtime: if not, the refusing proxy records a loopback target and every model request fails.',
    evidence:
      'HTTP_PROXYhttp_proxyHTTPS_PROXYhttps_proxyALL_PROXYall_proxyNO_PROXYno_proxy',
    offset: 60292232,
    status: 'static-reading-only',
  },
  {
    id: 'sdk-timing-fields',
    claim:
      'The SDK result message carries time_to_request_ms / time_to_request_from_spawn_ms; the probe records them next to its own polled timings.',
    evidence:
      'sdk.d.ts SDKResultSuccess: time_to_request_from_spawn_ms?: number',
    status: 'static-reading-only',
  },
  {
    id: 'no-pre-inference-hook',
    claim:
      'HOOK_EVENTS has no pre-request event. PostToolBatch ("fired once after every tool call in a batch has resolved, before the next model request") ' +
      'is the closest mid-loop point and its output can set continue:false; nothing runs before the very first request except SessionStart/UserPromptSubmit.',
    evidence:
      'sdk.d.ts HOOK_EVENTS (33 events) and PostToolBatchHookInput doc comment',
    status: 'static-reading-only',
  },
]);
