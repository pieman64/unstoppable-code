/**
 * The exact diagram from the CAN-5039 journey brief (review-brief.md), as
 * copied from the delivered document. Flow specs use the same text.
 * Verified against the supplied journey demo-spec.ts, lines 180–188.
 */
export const JOURNEY_BRIEF_DIAGRAM = [
  'flowchart LR',
  '  Cart --> Promo["Promo code?"]',
  '  Promo --> Shipping["Shipping address"]',
  '  Shipping --> Payment',
  '  Payment --> Billing["Billing address (again)"]',
  '  Billing --> Review',
  '  Review --> Confirm',
  '  classDef pain fill:#fde2e2,stroke:#d9534f,color:#5a1a1a',
  '  class Promo,Billing,Review pain',
].join('\n');
// Quoted and unquoted labels keep directive-like lines as authored text.
export const MULTILINE_LABEL_DIAGRAM = [
  'flowchart LR',
  'A["First line',
  'style A font-size:20px',
  'Last line"]-->B',
  'B[Unquoted node',
  'style B font-size:25px',
  'Last node line]-->C',
  'C-->|Unquoted edge',
  'style C font-size:30px',
  'Last edge line|D',
  'D>Asymmetric node',
  'style D font-size:35px',
  'Last asymmetric line]-->E',
  'E--Bare edge',
  'style guide',
  'before checkout-->F',
  'style B fill:#fde2e2',
].join('\n');
// CAN-5295: a Cowork runbook's dashed approval path, in the comma spelling.
export const DASHED_LINK_DIAGRAM = [
  'flowchart LR',
  '  Ticket[Escalation ticket] --> Triage[Tier 1 triage]',
  '  Triage --> Billing[Billing review]',
  '  Billing --> Refund{Refund over 500?}',
  '  Refund -->|Yes| Manager[Manager approval]',
  '  Refund -->|No| Resolve[Resolve and close]',
  '  Manager --> Resolve',
  '  linkStyle 3 stroke:#6b7280,stroke-dasharray:5,5',
].join('\n');
