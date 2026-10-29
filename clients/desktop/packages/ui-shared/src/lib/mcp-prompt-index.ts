/**
 * Curated static prompt index for MCP-aware suggested prompts (CAN-1809).
 *
 * Keys MUST match `CuratedMcpServerEntry.key` from the production curated
 * catalog (`@canopy/protocol/mcp-catalog`); the catalog itself is DB-driven,
 * so unknown keys here are harmless — they simply never match an enabled
 * server. Eligible curated servers WITHOUT an index entry are still
 * discoverable: the picker falls back to one synthesized prompt built from
 * the server's display name ({@link synthesizedPromptForServer}), so every
 * catalog connector — present and future — surfaces something. Prompt copy
 * describes user outcomes in natural language and must not reference tool
 * names, implementation details, or the product name.
 */

export interface SuggestedPrompt {
  /**
   * Stable id (`${curatedKey|'generic'}-${n}`) used for telemetry context and
   * UI-automation testids. Prompt text itself never leaves the client.
   */
  readonly id: string;
  /** Curated catalog key the prompt depends on; null for generic fallbacks. */
  readonly curatedKey: string | null;
  readonly text: string;
  /** A project starter prompt, written by its users rather than the app. */
  readonly userAuthored?: boolean;
}

function buildPrompts(
  curatedKey: string,
  texts: readonly string[],
): readonly SuggestedPrompt[] {
  return texts.map((text, index) => ({
    id: `${curatedKey}-${index + 1}`,
    curatedKey,
    text,
  }));
}

export const MCP_PROMPT_INDEX: Readonly<
  Record<string, readonly SuggestedPrompt[]>
> = {
  github: buildPrompts('github', [
    'Summarize pull requests waiting on my review',
    'Find open issues worth fixing first',
    'Draft release notes since the last release',
  ]),
  linear: buildPrompts('linear', [
    'Triage my unassigned Linear issues',
    'Summarize what my team shipped this cycle',
    'Turn my notes into a Linear issue',
  ]),
  figma: buildPrompts('figma', [
    'Implement my latest Figma design as code',
    'Compare a Figma design with the implementation',
    'Extract design tokens from my Figma file',
  ]),
  notion: buildPrompts('notion', [
    'Summarize recent updates in Notion',
    'Draft a project status page in Notion',
    'Find the Notion doc that answers my question',
  ]),
  slack: buildPrompts('slack', [
    'Summarize Slack discussions I missed today',
    'Draft a Slack update about my recent work',
    'Find the Slack thread behind a decision',
  ]),
  sentry: buildPrompts('sentry', [
    'Investigate my most frequent Sentry errors',
    'Explain my latest Sentry issue and its cause',
    'Summarize new crashes since the last release',
  ]),
  atlassian: buildPrompts('atlassian', [
    'Summarize the Jira tickets assigned to me',
    'Document my latest change in Confluence',
    'Break a Jira epic into subtasks',
  ]),
  stripe: buildPrompts('stripe', [
    'Summarize recent payment activity',
    'Explain why a recent payment failed',
    'Report subscription changes this month',
  ]),
  'gmail-gmailmcp': buildPrompts('gmail-gmailmcp', [
    'Summarize the emails waiting on my reply',
    'Draft a reply to my most recent email',
    'Find the email thread with the details I need',
  ]),
  'google-drive-drivemcp': buildPrompts('google-drive-drivemcp', [
    'Find the doc I was working on recently',
    'Summarize a document from my Drive',
    'Pull key points from a shared folder',
  ]),
  'google-calendar-calendarmcp': buildPrompts('google-calendar-calendarmcp', [
    'Summarize my meetings for the rest of the week',
    'Find a free slot for a new meeting',
    'Prep me for my next meeting',
  ]),
  'microsoft-365': buildPrompts('microsoft-365', [
    'Catch me up on my Outlook inbox',
    'Summarize a document from my OneDrive',
    'Prep me for my next meeting from my calendar',
  ]),
  hubspot: buildPrompts('hubspot', [
    'Summarize my open deals and their next steps',
    'Draft a follow-up email for a stalled deal',
    'Find contacts worth re-engaging this week',
  ]),
  monday: buildPrompts('monday', [
    'Summarize the status of my boards',
    'Find tasks that are overdue or stuck',
    'Turn my notes into board items',
  ]),
  intercom: buildPrompts('intercom', [
    'Summarize recent customer conversations',
    'Find the most common support issues this week',
    'Draft a reply to a tricky customer question',
  ]),
  miro: buildPrompts('miro', [
    'Summarize the ideas on my latest board',
    'Turn a brainstorm board into an action list',
    'Find the board where we mapped this out',
  ]),
  box: buildPrompts('box', [
    'Find the file I need in Box',
    'Summarize a contract stored in Box',
    'Pull key points from a shared Box folder',
  ]),
  dropbox: buildPrompts('dropbox', [
    'Find the file I need in Dropbox',
    'Summarize a document from my Dropbox',
    'Pull highlights from a shared Dropbox folder',
  ]),
  vercel: buildPrompts('vercel', [
    'Check why my latest deployment failed',
    'Summarize recent deployments and their status',
    'Dig into my production logs for errors',
  ]),
  netlify: buildPrompts('netlify', [
    'Check the status of my latest deploy',
    'Find out why my last build failed',
    'Summarize recent deploys across my sites',
  ]),
  supabase: buildPrompts('supabase', [
    'Explain my database schema to me',
    'Write a query to answer a data question',
    'Check my project for slow queries',
  ]),
  airtable: buildPrompts('airtable', [
    'Answer a question from my Airtable data',
    'Summarize the records in one of my bases',
    'Turn my notes into Airtable records',
  ]),
  zapier: buildPrompts('zapier', [
    'List my Zaps and what they automate',
    'Check which of my Zaps failed recently',
    'Find steps in my workflows worth automating',
  ]),
  asana: buildPrompts('asana', [
    'Summarize my tasks due this week',
    'Find overdue tasks across my projects',
    'Turn my notes into Asana tasks',
  ]),
  clickup: buildPrompts('clickup', [
    'Summarize my open tasks and priorities',
    'Find tasks that are blocked or overdue',
    'Turn my notes into ClickUp tasks',
  ]),
  trello: buildPrompts('trello', [
    'Summarize the state of my boards',
    'Find cards that have gone stale',
    'Turn my to-do list into Trello cards',
  ]),
  todoist: buildPrompts('todoist', [
    'Plan my day from my Todoist tasks',
    'Find tasks I keep postponing',
    'Turn my notes into Todoist tasks',
  ]),
  calendly: buildPrompts('calendly', [
    'Summarize my upcoming booked meetings',
    'Check which meeting types get booked most',
    'Find gaps in my availability next week',
  ]),
  shopify: buildPrompts('shopify', [
    'Summarize sales in my store this week',
    'Find my best-selling products this month',
    'Check for orders that need attention',
  ]),
  postman: buildPrompts('postman', [
    'Explain the endpoints in my API collections',
    'Draft tests for an API collection',
    'Help me debug a failing API request',
  ]),
  canva: buildPrompts('canva', [
    'Draft a social graphic for my latest update',
    'Turn my outline into a presentation',
    'Find and summarize my recent designs',
  ]),
  webflow: buildPrompts('webflow', [
    'Summarize the structure of my site',
    'Draft copy updates for a landing page',
    'Check my CMS content for gaps',
  ]),
  'wordpress-com': buildPrompts('wordpress-com', [
    'Draft a blog post from my notes',
    'List my drafts and what each still needs',
    'Refresh the copy on one of my pages',
  ]),
  cloudflare: buildPrompts('cloudflare', [
    'Summarize traffic across my sites',
    'Review my DNS records for issues',
    'Check the health of my Workers',
  ]),
  posthog: buildPrompts('posthog', [
    'Show me how users move through my product',
    'Find where users drop off in my funnel',
    'Check how my latest feature is being used',
  ]),
  mixpanel: buildPrompts('mixpanel', [
    'Answer a question from my product analytics',
    'Summarize user engagement this month',
    'Compare this week with last week',
  ]),
  amplitude: buildPrompts('amplitude', [
    'Summarize the key metrics for my product',
    'Find which features drive retention',
    'Explain a recent change in my metrics',
  ]),
  datadog: buildPrompts('datadog', [
    'Investigate my latest alerts and their causes',
    'Summarize error trends across my services',
    'Check the health of my services right now',
  ]),
  v0: buildPrompts('v0', [
    'Generate a UI component from my description',
    'Turn a rough idea into a working interface',
    'Iterate on my latest generation',
  ]),
  railway: buildPrompts('railway', [
    'Check the status of my deployed services',
    'Find out why my latest deploy failed',
    'Scan my service logs for errors',
  ]),
  planetscale: buildPrompts('planetscale', [
    'Walk me through my database schema',
    'Check my open deploy requests',
    'Query my database to answer a question',
  ]),
  clickhouse: buildPrompts('clickhouse', [
    'Answer a question straight from my data',
    'Summarize the tables in my database',
    'Find what is slowing down my queries',
  ]),
  bigquery: buildPrompts('bigquery', [
    'Query my warehouse to answer a question',
    'Summarize the datasets I have access to',
    'Explain what a complex query is doing',
  ]),
  motherduck: buildPrompts('motherduck', [
    'Run a quick analysis over my data',
    'Profile a dataset and describe its shape',
    'Summarize the tables in my warehouse',
  ]),
  'hugging-face': buildPrompts('hugging-face', [
    'Find a model that fits my use case',
    'Compare models for my task',
    'Summarize a dataset I am considering',
  ]),
  exa: buildPrompts('exa', [
    'Research a topic across the live web',
    'Find sources that support or refute a claim',
    'Compile recent news about my industry',
  ]),
  tavily: buildPrompts('tavily', [
    'Dig into a topic with live web research',
    'Summarize the latest news on a subject',
    'Find credible sources for my research',
  ]),
  context7: buildPrompts('context7', [
    'Look up current docs for a library I use',
    'Check the right API usage for a dependency',
    'Find code examples for a framework feature',
  ]),
  'stack-overflow': buildPrompts('stack-overflow', [
    'Find answers to my current error message',
    'Research approaches to a coding problem',
    'Check how others solved a similar bug',
  ]),
  paypal: buildPrompts('paypal', [
    'Summarize my recent transactions',
    'Check the status of a payment',
    'Report my payment volume this month',
  ]),
  square: buildPrompts('square', [
    'Summarize my sales this week',
    'Check my latest payouts',
    'Find my top-selling items',
  ]),
  twilio: buildPrompts('twilio', [
    'Check my recent message delivery rates',
    'Investigate failed message deliveries',
    'Summarize my messaging usage and costs',
  ]),
  resend: buildPrompts('resend', [
    'Check delivery rates for my recent emails',
    'Investigate why an email bounced',
    'Summarize my email sending this week',
  ]),
  granola: buildPrompts('granola', [
    'Turn my latest meeting into action items',
    'Summarize my meetings from this week',
    'Find the meeting where we decided this',
  ]),
  fireflies: buildPrompts('fireflies', [
    'List the commitments from my latest meeting',
    'Recap the meetings I had this week',
    'Find who committed to what in a meeting',
  ]),
  pagerduty: buildPrompts('pagerduty', [
    'Summarize my open incidents',
    'Check who is on call right now',
    'Review recent incident trends',
  ]),
  'incident-io': buildPrompts('incident-io', [
    'Summarize our recent incidents',
    'Draft a post-incident summary',
    'Look for recurring incident patterns',
  ]),
  honeycomb: buildPrompts('honeycomb', [
    'Investigate a latency spike in my service',
    'Find my slowest endpoints right now',
    'Explain an anomaly in my traces',
  ]),
  quickbooks: buildPrompts('quickbooks', [
    'Summarize my income and expenses this month',
    'Find unpaid invoices worth chasing',
    'Categorize my recent transactions',
  ]),
  xero: buildPrompts('xero', [
    'Summarize my cash position',
    'Find overdue invoices to follow up on',
    'Review my expenses this month',
  ]),
  klaviyo: buildPrompts('klaviyo', [
    'Summarize my recent campaign performance',
    'Find my most engaged customer segments',
    'Draft my next campaign email',
  ]),
  'intuit-mailchimp': buildPrompts('intuit-mailchimp', [
    'Summarize how my latest campaign performed',
    'Draft my next newsletter',
    'Find which subject lines performed best',
  ]),
  attio: buildPrompts('attio', [
    'Summarize my pipeline and next steps',
    'Find contacts I should follow up with',
    'Log my meeting notes against the right company',
  ]),
  workos: buildPrompts('workos', [
    'Check the health of my SSO connections',
    'Summarize recent directory sync activity',
    'Look up how an organization signs in',
  ]),
  sanity: buildPrompts('sanity', [
    'Find content that needs updating',
    'Draft a new entry from my notes',
    'Summarize how my content is structured',
  ]),
  mintlify: buildPrompts('mintlify', [
    'Find gaps in my documentation',
    'Draft a new docs page from my notes',
    'Check my docs for outdated content',
  ]),
  swagger: buildPrompts('swagger', [
    'Explain the endpoints in my API spec',
    'Find inconsistencies in my API spec',
    'Draft docs for an undocumented endpoint',
  ]),
  ramp: buildPrompts('ramp', [
    'Summarize company spend this month',
    'Find unusual transactions worth reviewing',
    'Check which receipts I still owe',
  ]),
  brex: buildPrompts('brex', [
    'Summarize recent card spend',
    'Find transactions missing receipts',
    'Report spend by team this month',
  ]),
  mercury: buildPrompts('mercury', [
    'Summarize my balances and cash flow',
    'Find large recent transactions',
    'Check for upcoming scheduled payments',
  ]),
  'otter-ai': buildPrompts('otter-ai', [
    'Summarize my latest meeting transcript',
    'Pull action items from my recent meetings',
    'Find the conversation where we decided this',
  ]),
  fathom: buildPrompts('fathom', [
    'Summarize my latest recorded call',
    'Pull action items from my recent calls',
    'Surface key moments from my recent calls',
  ]),
  docusign: buildPrompts('docusign', [
    'Check which documents await signature',
    'Summarize a contract before I sign it',
    'Draft a reminder for pending signatures',
  ]),
  gamma: buildPrompts('gamma', [
    'Turn my outline into a presentation',
    'Draft a deck for my project update',
    'Polish the flow of my existing deck',
  ]),
  elevenlabs: buildPrompts('elevenlabs', [
    'Turn my script into natural speech',
    'Find the right voice for my project',
    'Draft and voice a short narration',
  ]),
  ahrefs: buildPrompts('ahrefs', [
    'Find keyword opportunities for my site',
    'Summarize my backlink profile',
    'Check which pages drive the most traffic',
  ]),
  semrush: buildPrompts('semrush', [
    'Research keywords for my next article',
    'Audit the SEO health of my site',
    'Compare my rankings with a competitor',
  ]),
  spotify: buildPrompts('spotify', [
    'Build me a playlist for deep focus',
    'Find music like what I have been playing',
    'Queue up something for my current mood',
  ]),
  strava: buildPrompts('strava', [
    'Summarize my training this month',
    'Compare my recent runs with last month',
    'Plan my next week of workouts',
  ]),
  'zoom-for-claude': buildPrompts('zoom-for-claude', [
    'Summarize my recent Zoom meetings',
    'Pull action items from my last meeting',
    'Find the meeting recording I need',
  ]),
};

/**
 * Name-based fallback prompt for an eligible curated server with no
 * hand-written index entry. Keeps the curated key (so telemetry and the
 * brand-logo lookup behave like indexed prompts) with a `-synthesized-` id
 * segment distinguishing it from hand-written copy. The display name comes
 * from the detected server definition; the key is the last-resort label.
 */
export function synthesizedPromptForServer(
  curatedKey: string,
  displayName: string,
): SuggestedPrompt {
  const name = displayName.trim();
  return {
    id: `${curatedKey}-synthesized-1`,
    curatedKey,
    text: `Show me what I can do with ${name.length > 0 ? name : curatedKey}`,
  };
}

export type GenericPromptSurface = 'home' | 'chat' | 'cowork';

export const GENERIC_FALLBACK_PROMPTS: Readonly<
  Record<GenericPromptSurface, readonly SuggestedPrompt[]>
> = {
  home: [
    'Research a topic and write up what matters',
    'Plan a project and break it into steps',
    'Turn rough notes into a polished document',
    'Draft an email, post, or announcement',
    'Make sense of a spreadsheet or data file',
    'Build a small tool from scratch',
  ].map((text, index) => ({
    id: `generic-home-${index + 1}`,
    curatedKey: null,
    text,
  })),
  /**
   * Cowork projects are not git-backed, so the `chat` pool's codebase
   * vocabulary is actively wrong there (CAN-2964): a blank chat in a
   * non-git project used to be offered "Explain the architecture of this
   * codebase". This pool is outcome-flavored instead, matching the register
   * the web `/chat` entry screen already uses.
   *
   * Ids are positional and are emitted as telemetry. Entries may be appended
   * or edited in place; they must never be reordered or spliced out of the
   * middle. `generic-cowork-*` also keeps this pool namespaced away from the
   * workspace-scoped `ws-*` ids a project's own starter prompts carry.
   */
  cowork: [
    'Summarize a long document I paste in',
    'Turn my rough notes into a clear plan',
    'Draft an email I have been putting off',
    "Explain something I don't understand yet",
    'Compare two options and weigh the tradeoffs',
    'Break a big job into small steps',
    'Give me feedback on something I wrote',
    'Make a checklist I can actually follow',
    'Help me think through a decision',
  ].map((text, index) => ({
    id: `generic-cowork-${index + 1}`,
    curatedKey: null,
    text,
  })),
  chat: [
    'Explain the architecture of this codebase',
    'Find and fix a small bug worth cleaning up',
    'Review my latest changes and suggest fixes',
    'Add tests to the least-tested code',
    'Write docs for an undocumented area',
  ].map((text, index) => ({
    id: `generic-${index + 1}`,
    curatedKey: null,
    text,
  })),
};
