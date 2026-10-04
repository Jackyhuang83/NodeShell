import { databaseLogger } from "../utils/logger.js";
import { getErrorMessage } from "../utils/error-message.js";

/**
 * NodeShell starts from its own v0.1 schema and does not migrate removed
 * Termix plugins or desktop/sync features.
 *
 * After bundled plugins activate we only recompute current host defaults.
 */
export async function runPluginDataMigrations(): Promise<void> {
  try {
    const { recomputeEverything } =
      await import("../hosts/defaults/recompute.js");
    recomputeEverything("plugins started");
  } catch (error) {
    databaseLogger.warn("Could not apply host defaults", {
      operation: "host_defaults_recompute",
      error: getErrorMessage(error),
    });
  }
}
