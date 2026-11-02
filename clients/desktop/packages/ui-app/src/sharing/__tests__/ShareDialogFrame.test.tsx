/**
 * @jest-environment jsdom
 */
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ShareDialogFrame,
  sharePartialMessage,
  shareStageCaption,
  shareSuccessNotice,
} from '../ShareDialogFrame';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type FrameProps = ComponentProps<typeof ShareDialogFrame>;

function byTestId<T extends Element = HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

describe('ShareDialogFrame', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderFrame(overrides: Partial<FrameProps> = {}): void {
    const props: FrameProps = {
      title: 'Share project',
      testIdPrefix: 'share-x',
      onDismiss: jest.fn(),
      lifecycle: { status: 'idle', committed: false },
      scope: <input data-testid="share-x-scope-input" />,
      content: <input data-testid="share-x-content-input" />,
      submitLabel: 'Share',
      sharingLabel: 'Sharing…',
      onSubmit: jest.fn(),
      ...overrides,
    };
    act(() => root.render(<ShareDialogFrame {...props} />));
  }

  it('renders the common layout with Share and header dismissal', () => {
    renderFrame({ after: <section data-testid="share-x-people" /> });
    expect(byTestId('share-x-modal')?.textContent).toContain('Share project');
    expect(byTestId<HTMLFieldSetElement>('share-x-form')?.disabled).toBe(false);
    expect(byTestId('share-x-people')).not.toBeNull();
    expect(byTestId('share-x-cancel')).toBeNull();
    expect(byTestId('share-x-submit')?.textContent).toBe('Share');
    expect(byTestId('share-x-footer')).not.toBeNull();
    expect(byTestId('share-x-error')).toBeNull();
    expect(byTestId('share-x-unavailable')).toBeNull();
  });

  it('locks the form, Cancel and dismissal while sharing and spins the primary', () => {
    const onDismiss = jest.fn();
    renderFrame({
      onDismiss,
      lifecycle: { status: 'sharing', committed: false },
      after: <button type="button" data-testid="share-x-after-action" />,
    });
    expect(byTestId<HTMLFieldSetElement>('share-x-form')?.disabled).toBe(true);
    // The trailing section stays outside the locked form.
    expect(
      byTestId('share-x-form')?.contains(byTestId('share-x-after-action')),
    ).toBe(false);
    const submit = byTestId<HTMLButtonElement>('share-x-submit');
    expect(submit?.textContent).toBe('Sharing…');
    expect(submit?.disabled).toBe(true);
    expect(byTestId('share-x-submit-spinner')).not.toBeNull();
    expect(byTestId('share-x-cancel')).toBeNull();
  });

  it('shows the package stage caption and a determinate bar while sharing', () => {
    renderFrame({
      lifecycle: { status: 'sharing', committed: false },
      stage: { stage: 'Uploading dependencies…', completed: 3, total: 12 },
      link: { url: 'https://cloud.test/s/1', kind: 'public' },
    });
    const stage = byTestId('share-x-stage');
    expect(stage?.textContent).toContain('Uploading dependencies · 3 of 12');
    expect(
      stage
        ?.querySelector('[role="progressbar"]')
        ?.getAttribute('aria-valuenow'),
    ).toBe('25');
    // The stage takes over the slot: no Copy link while sharing.
    expect(byTestId('share-x-copy-link')).toBeNull();
  });

  it('pins the error notice above the footer', () => {
    renderFrame({
      lifecycle: { status: 'error', committed: false },
      errorMessage: "Couldn't share the project. Network down.",
    });
    const error = byTestId('share-x-error');
    expect(error?.textContent).toContain(
      "Couldn't share the project. Network down.",
    );
    expect(error?.getAttribute('role')).toBe('alert');
    expect(byTestId('share-x-submit')?.textContent).toBe('Share');
  });

  it('shows the partial notice with Done and Retry public link', () => {
    const onRetryPublic = jest.fn();
    renderFrame({
      lifecycle: { status: 'partial', committed: true },
      partialMessage: sharePartialMessage('skill', 'Platform'),
      onRetryPublic,
    });
    expect(byTestId('share-x-partial')?.textContent).toContain(
      "Shared with Platform, but the public link couldn't be created.",
    );
    expect(byTestId('share-x-done')?.textContent).toBe('Done');
    const retry = byTestId<HTMLButtonElement>('share-x-retry-public');
    expect(retry?.textContent).toBe('Retry public link');
    act(() => retry?.click());
    expect(onRetryPublic).toHaveBeenCalledTimes(1);
  });

  it('relabels Cancel to Done once something landed', () => {
    const onDismiss = jest.fn();
    renderFrame({ onDismiss, lifecycle: { status: 'idle', committed: true } });
    expect(byTestId('share-x-cancel')).toBeNull();
    const done = byTestId<HTMLButtonElement>('share-x-done');
    expect(done?.textContent).toBe('Done');
    act(() => done?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('shows Copy link in the footer when a link is set', () => {
    renderFrame({ link: { url: 'https://cloud.test/s/1', kind: 'scoped' } });
    expect(byTestId('share-x-copy-link')?.textContent).toBe('Copy link');
  });

  it('replaces the layout with the gate and hides Copy link there', () => {
    renderFrame({
      gate: <p data-testid="share-x-blocked">Push to GitHub first.</p>,
      link: { url: 'https://cloud.test/s/1', kind: 'public' },
      showSubmit: false,
      secondaryAction: {
        label: 'Manage existing access',
        onClick: jest.fn(),
        testId: 'share-x-manage',
      },
    });
    expect(
      byTestId('share-x-unavailable')?.contains(byTestId('share-x-blocked')),
    ).toBe(true);
    expect(byTestId('share-x-form')).toBeNull();
    expect(byTestId('share-x-copy-link')).toBeNull();
    expect(byTestId('share-x-submit')).toBeNull();
    expect(byTestId('share-x-manage')?.textContent).toBe(
      'Manage existing access',
    );
  });

  it('renders no empty footer when a gate hides every footer action', () => {
    renderFrame({
      gate: <p data-testid="share-x-blocked">Push to GitHub first.</p>,
      showSubmit: false,
      link: { url: 'https://cloud.test/s/1', kind: 'public' },
    });
    expect(byTestId('share-x-blocked')).not.toBeNull();
    expect(byTestId('share-x-footer')).toBeNull();
  });

  it('pins the success notice with the link beside Copy link and Done', () => {
    const url = 'https://cloud.test/s/1';
    renderFrame({
      lifecycle: { status: 'success', committed: true },
      success: { tone: 'success', message: 'Project is now public', link: url },
      showSubmit: false,
      link: { url, kind: 'public' },
    });
    const success = byTestId('share-x-success');
    expect(success?.textContent).toContain('Project is now public');
    expect(success?.getAttribute('role')).toBe('status');
    expect(byTestId('share-x-link')?.textContent).toBe(url);
    expect(byTestId('share-x-copy-link')?.textContent).toBe('Copy link');
    expect(byTestId('share-x-done')).not.toBeNull();
    expect(byTestId('share-x-submit')).toBeNull();
    expect(byTestId('share-x-error')).toBeNull();
  });

  it('shows a linkless success as one sentence', () => {
    renderFrame({
      lifecycle: { status: 'success', committed: true },
      success: { tone: 'success', message: 'Project shared with Platform' },
      showSubmit: false,
    });
    expect(byTestId('share-x-success')?.textContent).toBe(
      'Project shared with Platform',
    );
    expect(byTestId('share-x-link')).toBeNull();
    expect(byTestId('share-x-copy-link')).toBeNull();
  });
});

describe('share success copy', () => {
  it('names the audience and never says "successfully"', () => {
    expect(
      shareSuccessNotice({
        noun: 'pipeline',
        scope: 'team',
        targetName: 'Platform',
        isUpdate: false,
      }),
    ).toEqual({ tone: 'success', message: 'Pipeline shared with Platform' });
    expect(
      shareSuccessNotice({
        noun: 'pipeline',
        scope: 'organization',
        targetName: 'Acme',
        isUpdate: false,
        shareUrl: 'https://cloud.test/o/1',
      }),
    ).toEqual({
      tone: 'success',
      message: 'Pipeline shared with Acme',
      link: 'https://cloud.test/o/1',
    });
    expect(
      shareSuccessNotice({ noun: 'skill', scope: 'public', isUpdate: false })
        .message,
    ).toBe('Skill is now public');
    // Reopening on an item that was already public: no "now".
    expect(
      shareSuccessNotice({
        noun: 'skill',
        scope: 'public',
        isUpdate: false,
        reopened: true,
      }).message,
    ).toBe('Skill is public');
    expect(
      shareSuccessNotice({ noun: 'skill', scope: 'public', isUpdate: true })
        .message,
    ).toBe('Skill updated');
  });

  it('turns a host message into a warning notice', () => {
    expect(
      shareSuccessNotice({
        noun: 'skill',
        scope: 'public',
        isUpdate: false,
        message: 'Your skill is still being shared.',
      }),
    ).toEqual({
      tone: 'warning',
      message: 'Your skill is still being shared.',
    });
  });

  it('captions a stage without counts as-is', () => {
    expect(shareStageCaption({ stage: 'Preparing package…' })).toBe(
      'Preparing package…',
    );
  });

  it('captions the publishing stage as a workflow while the wire value keeps its name (CAN-4651)', () => {
    expect(shareStageCaption({ stage: 'Publishing pipeline…' })).toBe(
      'Publishing workflow…',
    );
  });

  it('captions the file-oriented stages and never counts zero work', () => {
    expect(
      shareStageCaption({ stage: 'Uploading files…', completed: 2, total: 5 }),
    ).toBe('Uploading files · 2 of 5');
    expect(
      shareStageCaption({ stage: 'Uploading files…', completed: 0, total: 0 }),
    ).toBe('Uploading files…');
    expect(shareStageCaption({ stage: 'Finishing upload…' })).toBe(
      'Finishing upload…',
    );
  });

  it('falls back to a generic caption for a stage it does not know', () => {
    // A newer producer's stage arrives over IPC as data the union doesn't
    // name; build it the same way.
    const fromNewerProducer: unknown = JSON.parse(
      '{"stage":"Compressing files…"}',
    );
    const isProgressEvent = (
      value: unknown,
    ): value is Parameters<typeof shareStageCaption>[0] =>
      typeof value === 'object' && value !== null && 'stage' in value;
    expect(isProgressEvent(fromNewerProducer)).toBe(true);
    if (isProgressEvent(fromNewerProducer)) {
      expect(shareStageCaption(fromNewerProducer)).toBe('Sharing…');
    }
  });
});
