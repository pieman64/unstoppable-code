import {
  authRequestDialogAnswer,
  fileChooserDialogAnswer,
  printRequestDialogAnswer,
} from '../browser-pending-surfaces';

describe('fileChooserDialogAnswer', () => {
  it('leaves JavaScript dialog ids alone', () => {
    expect(
      fileChooserDialogAnswer('0b6f2c1e-6a35-4c58-9d2a-1f0c2c4b5e7a', true),
    ).toEqual({ kind: 'not_a_chooser' });
  });

  it('dismisses a chooser, and refuses to accept one with a pointer to upload_files', () => {
    expect(fileChooserDialogAnswer('chooser-1', false)).toEqual({
      kind: 'dismiss',
      chooserId: 'chooser-1',
    });
    expect(fileChooserDialogAnswer('chooser-1', true)).toMatchObject({
      kind: 'refuse',
      error: {
        code: 'unsupported_control',
        retryable: false,
        next: 'browser.upload_files',
      },
    });
  });
});

describe('printRequestDialogAnswer', () => {
  it('leaves other ids alone, saves a PDF on accept, and dismisses otherwise', () => {
    expect(printRequestDialogAnswer('chooser-1', true)).toEqual({
      kind: 'not_a_print_request',
    });
    expect(printRequestDialogAnswer('print-1', true)).toEqual({
      kind: 'answer',
      printRequestId: 'print-1',
      answer: 'save_pdf',
    });
    expect(printRequestDialogAnswer('print-1', false)).toEqual({
      kind: 'answer',
      printRequestId: 'print-1',
      answer: 'dismiss',
    });
  });
});

describe('authRequestDialogAnswer', () => {
  it('leaves other ids alone, cancels on dismiss, and refuses to accept for the user', () => {
    expect(authRequestDialogAnswer('print-1', true)).toEqual({
      kind: 'not_an_auth_request',
    });
    expect(authRequestDialogAnswer('auth-1', false)).toEqual({
      kind: 'cancel',
      authRequestId: 'auth-1',
    });
    expect(authRequestDialogAnswer('auth-1', true)).toMatchObject({
      kind: 'refuse',
      error: { code: 'policy_denied', retryable: false },
    });
  });
});
