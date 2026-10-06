import { authApi } from "@/main-axios";

export interface SshAuthProviderSummary {
  type: string;
  labelKey: string;
  descriptionKey?: string;
  pluginId: string;
  fields: Array<Record<string, unknown>>;
  credentialType: boolean;
  needsUserInteraction: boolean;
  supportsBackground: boolean;
  available: boolean;
  missingPlugin?: { id: string; name: string };
}

/** SSH authentication providers available to the saved-host editor. */
export async function getSshAuthProviders(): Promise<SshAuthProviderSummary[]> {
  try {
    const response = await authApi.get("/ssh-auth/providers");
    return Array.isArray(response.data?.providers)
      ? response.data.providers
      : [];
  } catch {
    return [];
  }
}
