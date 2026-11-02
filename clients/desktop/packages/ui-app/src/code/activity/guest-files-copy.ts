export const GUEST_FILES_MESSAGE =
  'Attachments and workspace files need an account.';

export const ATTACHMENT_SIGN_IN_COPY = {
  title: 'Sign in to add files',
  body: `${GUEST_FILES_MESSAGE} Sign in and this chat comes with you.`,
} as const;
