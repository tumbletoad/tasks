// A home's access through the service's agent-home rows (hub/agent-homes.ts): the command line
// asks for them over its connection, the page in the service itself, with the same two verbs.
import { AppError } from "@ttasks/contracts";
import { GrantRefused, type Access, type AgentHome, type RegistrationOf } from "./agents.ts";

/** One of the service's `setup/*` verbs. It throws an AppError when the service refuses. */
export type RowCall = (
  method: "setup/home_grant" | "setup/home_revoke",
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** The registration a verb is for: the home's file, its ID and the row its record names. */
const registrationParams = (home: AgentHome, of: RegistrationOf) => ({
  app: home.app,
  home: home.home,
  file: home.file,
  ...(of.registration === undefined ? {} : { registration: of.registration }),
  ...(of.recorded === undefined ? {} : { grant: of.recorded }),
});

/** A home's access as the service's rows: given with `setup/home_grant`, taken back with `setup/home_revoke`. */
export function rowAccess(call: RowCall): Access {
  return {
    async grant(home, space, of) {
      let granted: Record<string, unknown>;
      try {
        granted = await call("setup/home_grant", {
          ...registrationParams(home, of),
          instance: home.instance,
          account: home.account,
          hosts: home.hosts,
          space,
        });
      } catch (error) {
        const taken = error instanceof AppError && error.data["reason"] === "instance_taken";
        throw new GrantRefused(taken ? "instance_taken" : "grant_failed");
      }
      const grant = (granted["grant"] as { grant?: unknown } | undefined)?.grant;
      if (typeof grant !== "string") throw new GrantRefused("grant_failed");
      return grant;
    },
    async revoke(home, of) {
      await call("setup/home_revoke", registrationParams(home, of));
    },
  };
}
