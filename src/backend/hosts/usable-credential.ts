import { createCurrentHostResolutionRepository } from "../database/repositories/factory.js";
import type { HostResolutionCredentialRecord } from "../database/repositories/host-resolution-repository.js";

/**
 * NodeShell v0.1 is single-owner: a credential is usable only when it belongs
 * to the authenticated Owner. No role/share fallback exists.
 */
export async function findUsableCredential(
  credentialId: number,
  userId: string,
): Promise<HostResolutionCredentialRecord | null> {
  return createCurrentHostResolutionRepository().findCredentialByIdForUser(
    credentialId,
    userId,
  );
}
