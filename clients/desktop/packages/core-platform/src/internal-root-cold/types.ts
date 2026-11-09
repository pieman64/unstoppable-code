import type { LinuxColdPathIdentity } from './linux-mounts';

/** Worker-local snapshot. Never includes process arguments or environments. */
export interface NativeColdProcess {
  readonly pid: number;
  /**
   * Windows exited/post-T rows retain mandatory images; post-T file use is optional.
   * Linux proven-absent exited rows have no image or paths.
   */
  readonly scope:
    | 'same-user'
    | 'foreign'
    | 'linux-user-manager'
    | 'linux-root-principal'
    | 'exited'
    | 'post-t';
  readonly parentPid: number | null;
  readonly startIdentity: string | null;
  readonly executable: string | null;
  /** Linux Crashpad only: complete, stability-checked executable-directory names. */
  readonly executableDirectoryEntries?: readonly string[];
  /** Linux only: one complete, rechecked same-namespace mount table per snapshot. */
  readonly linuxMountInfo?: string;
  /** Linux mappings: all visible/covered same-device coordinates; any may be affected. */
  readonly linuxMappingCandidates?: readonly LinuxColdPathIdentity[];
  /** Linux roots-bound inspection (including private mounts) requires these exact census roots. */
  readonly linuxPrivateMountUse?: {
    readonly roots: readonly string[];
    readonly affected: boolean;
  };
  /** Worker-local proc root for an object-inspected executable, never a host pathname. */
  readonly linuxExecutableRoot?: string;
  readonly comm?: string;
  /** Windows pinned File objects: DeletePending with no remaining directory links. */
  readonly windowsUnlinkedFiles?: readonly {
    readonly volumeSerial: string;
    readonly fileId: string;
  }[];
  /** Windows kernel mapping names in the reserved volume-root NTFS deleted namespace. */
  readonly windowsDeletedMappings?: readonly string[];
  readonly paths: readonly string[];
}
