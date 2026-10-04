import { authApi, handleApiError } from "@/main-axios";

/** Record a lightweight host activity used by SSH/SFTP UX. */
export async function logActivity(
  type: string,
  hostId: number,
  hostName: string,
): Promise<{ message: string; id: number | string }> {
  try {
    const response = await authApi.post("/dashboard/activity/log", {
      type,
      hostId,
      hostName,
    });
    return response.data;
  } catch (error) {
    throw handleApiError(error, "log activity");
  }
}
