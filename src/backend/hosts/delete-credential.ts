import {
  createCurrentCredentialRepository,
  createCurrentHostRepository,
  createCurrentHostResolutionRepository,
} from "../database/repositories/factory.js";

/**
 * Deletes a credential the user owns: hosts using it fall back to password
 * auth with no secret. Shared by the delete
 * route and sync. Null when it does not exist or is not the user's.
 */
export async function deleteOwnedCredential(
  userId: string,
  credentialId: number,
): Promise<{ name: string | null } | null> {
  const credential =
    await createCurrentCredentialRepository().findDecryptedByIdForUser(
      userId,
      credentialId,
    );
  if (!credential) return null;

  const hostsUsingCredential =
    await createCurrentHostResolutionRepository().listHostsUsingCredentialForUser(
      userId,
      credentialId,
    );

  if (hostsUsingCredential.length > 0) {
    await createCurrentHostRepository().updateManyForUser(
      userId,
      hostsUsingCredential.map((host) => host.id),
      {
        credentialId: null,
        password: null,
        key: null,
        keyPassword: null,
        authType: "password",
      },
    );
  }

  await createCurrentCredentialRepository().deleteForUser(userId, credentialId);
  return { name: (credential.name as string | null) ?? null };
}
