import type {
  GuardedStorageNamespace,
  StorageWriterPrincipal,
} from '../../storage';

/** Host-supplied storage ownership; this contract does not admit a write. */
export interface W5StorageTarget {
  namespace: GuardedStorageNamespace;
  writer: StorageWriterPrincipal;
}
