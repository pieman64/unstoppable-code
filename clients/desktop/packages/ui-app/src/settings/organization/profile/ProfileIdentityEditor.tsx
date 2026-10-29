'use client';

import {
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type JSX,
  type ReactNode,
} from 'react';
import { Camera, Pencil } from '@canopy/ui-shared/icons/AppIcons';
import {
  ALLOWED_AVATAR_MIME_TYPES,
  PROFILE_NAME_MAX_LENGTH,
  PROFILE_NAME_MIN_LENGTH,
} from '@canopy/protocol/settings/account';
import { useSettingsPrivacy } from '../../host';
import { withPrivacyClass } from '../../account/privacy-class';
import { MemberAvatar } from '../MemberAvatar';
import { useProfileEditor, type ProfileEditTarget } from './use-profile-editor';

const AVATAR_INPUT_ACCEPT = ALLOWED_AVATAR_MIME_TYPES.join(',');

interface AvatarEditorProps {
  name: string;
  image: string | null;
  size?: number;
  busy: boolean;
  error: string | null;
  onPick: (file: File) => void;
  onRemove: () => void;
}

/**
 * Avatar with a hover/focus "change photo" overlay that opens a file picker,
 * plus a "Remove photo" affordance when a custom image is set. Presentational:
 * the parent owns the upload state and feeds `busy`/`error` back in.
 */
export function AvatarEditor({
  name,
  image,
  size = 72,
  busy,
  error,
  onPick,
  onRemove,
}: AvatarEditorProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const { blockClassName } = useSettingsPrivacy();

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Reset so re-picking the same file re-triggers `onChange`.
    event.target.value = '';
    if (file) {
      onPick(file);
    }
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        data-testid="profile-avatar-edit"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        aria-label="Change profile photo"
        className={withPrivacyClass(
          'group relative rounded-full disabled:cursor-not-allowed',
          blockClassName,
        )}
        style={{ width: size, height: size }}
      >
        <MemberAvatar name={name} image={image} size={size} />
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          {busy ? (
            <span className="text-xs font-medium">…</span>
          ) : (
            <Camera size={Math.max(16, Math.round(size / 4))} />
          )}
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={AVATAR_INPUT_ACCEPT}
        className="sr-only"
        data-testid="profile-avatar-input"
        onChange={handleChange}
      />
      {image && (
        <button
          type="button"
          data-testid="profile-avatar-remove"
          onClick={onRemove}
          disabled={busy}
          className="text-xs font-medium fg-secondary transition-colors hover:fg-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          Remove photo
        </button>
      )}
      {error && (
        <p className="max-w-48 text-center text-xs fg-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface NameEditorProps {
  name: string;
  busy: boolean;
  error: string | null;
  onSave: (name: string) => void;
  onOpen: () => void;
  /** Rendered next to the name in read mode (e.g. a role badge). */
  aux?: ReactNode;
}

/**
 * Inline-editable display name: an `<h1>` with a pencil affordance that swaps
 * to a text input + Save/Cancel. The parent persists via the shared editor and
 * feeds `busy`/`error` back in.
 */
export function NameEditor({
  name,
  busy,
  error,
  onSave,
  onOpen,
  aux,
}: NameEditorProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const { blockClassName } = useSettingsPrivacy();

  const open = (): void => {
    setDraft(name);
    onOpen();
    setEditing(true);
  };

  const cancel = (): void => {
    setEditing(false);
    setDraft(name);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (
      trimmed.length < PROFILE_NAME_MIN_LENGTH ||
      trimmed.length > PROFILE_NAME_MAX_LENGTH ||
      busy
    ) {
      return;
    }
    onSave(trimmed);
    setEditing(false);
  };

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <h1
          data-testid="profile-name"
          className={withPrivacyClass(
            'truncate text-xl font-semibold fg-primary',
            blockClassName,
          )}
        >
          {name}
        </h1>
        {aux}
        <button
          type="button"
          data-testid="profile-name-edit"
          onClick={open}
          aria-label="Edit display name"
          className="rounded-md p-1 fg-secondary transition-colors hover:bg-secondary hover:fg-primary"
        >
          <Pencil size={14} />
        </button>
        {error && (
          <p className="w-full text-xs fg-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        required
        autoFocus
        value={draft}
        maxLength={PROFILE_NAME_MAX_LENGTH}
        onChange={(event) => setDraft(event.target.value)}
        disabled={busy}
        data-testid="profile-name-input"
        aria-label="Display name"
        className={withPrivacyClass(
          'min-w-0 flex-1 rounded-md border bg-card px-2 py-1 text-xl font-semibold fg-primary disabled:opacity-50',
          blockClassName,
        )}
      />
      <button
        type="submit"
        disabled={busy || draft.trim().length < PROFILE_NAME_MIN_LENGTH}
        data-testid="profile-name-save"
        className="rounded-md bg-accent px-3 py-1.5 text-s font-medium fg-emphasis transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        onClick={cancel}
        disabled={busy}
        data-testid="profile-name-cancel"
        className="rounded-md border px-3 py-1.5 text-s font-medium fg-primary transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
      >
        Cancel
      </button>
      {error && (
        <p className="w-full text-xs fg-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

interface ProfileIdentityEditorProps {
  initialName: string;
  initialImage: string | null;
  /** Rendered next to the name (e.g. the org role badge). */
  roleBadge?: ReactNode;
  /** The remaining (read-only) meta column content. */
  children?: ReactNode;
  avatarSize?: number;
  /**
   * Which identity these edits write to. Defaults to the signed-in user's own
   * global profile (`{ mode: 'self' }`); pass an `org-member` target to edit
   * another member's org-scoped override instead.
   */
  target?: ProfileEditTarget;
}

/**
 * The owner-editable identity block of a member profile header: an editable
 * avatar plus an inline-editable display name, with the read-only meta column
 * (email / member-since / bio / links) passed through as `children`. Holds the
 * locally-optimistic `name`/`image` so edits reflect immediately without a
 * reload; full site-wide propagation lands on the next navigation.
 */
export function ProfileIdentityEditor({
  initialName,
  initialImage,
  roleBadge,
  children,
  avatarSize = 72,
  target,
}: ProfileIdentityEditorProps): JSX.Element {
  const [name, setName] = useState(initialName);
  const [image, setImage] = useState<string | null>(initialImage);
  const editor = useProfileEditor(target);

  const handlePick = (file: File): void => {
    void editor.uploadAvatar(file).then((url) => {
      if (url) {
        setImage(url);
      }
    });
  };

  const handleRemove = (): void => {
    void editor.removeAvatar().then((ok) => {
      if (ok) {
        setImage(null);
      }
    });
  };

  const handleSaveName = (next: string): void => {
    void editor.updateName(next).then((saved) => {
      if (saved) {
        setName(saved);
      }
    });
  };

  return (
    <>
      <AvatarEditor
        name={name}
        image={image}
        size={avatarSize}
        busy={editor.busy}
        error={editor.error}
        onPick={handlePick}
        onRemove={handleRemove}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <NameEditor
          name={name}
          busy={editor.busy}
          error={editor.error}
          onOpen={editor.clearError}
          onSave={handleSaveName}
          aux={roleBadge}
        />
        {children}
      </div>
    </>
  );
}
