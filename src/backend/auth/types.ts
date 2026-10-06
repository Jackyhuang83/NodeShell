export { LoginMethodError } from "@termix/plugin-sdk/backend";

/** Identity proven by the only browser login mode in NodeShell v0.1. */
export interface VerifiedIdentity {
  kind: "user";
  userId: string;
  password?: string;
  rememberMe?: boolean;
  rateLimitUsername?: string;
}
