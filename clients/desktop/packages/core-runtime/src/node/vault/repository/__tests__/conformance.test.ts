import { runVaultRepositoryConformance } from '../../../../vault/testing';
import { createDurableVaultSubject } from './durable-subject';

// The shared V0 kit, unchanged, on the durable store (CAN-5448).
runVaultRepositoryConformance({ describe, it }, createDurableVaultSubject);
