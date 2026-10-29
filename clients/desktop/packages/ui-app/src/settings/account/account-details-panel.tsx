// The Account and Security tab panels, split into their own modules. This
// path keeps the panels' original import site working (the web
// `components/account-details-panel` compat file re-exports it).
export {
  AccountBasicsSection,
  AccountPanel,
  ProfileSection,
  type AccountPanelProps,
} from './AccountPanel';
export {
  AuthSourceRow,
  PasswordSection,
  SecurityPanel,
  formatLinkedDate,
  type SecurityPanelProps,
} from './SecurityPanel';
