// The lines a person reads about the UI's port (A2 3.8.2), the same in `ttasks open`, `tasks
// service status` and doctor. Storage-free, so the CLI imports them (`@ttasks/service/http/shared`).
import { CLI_NAME, PRODUCT_NAME } from "@ttasks/brand";

/** A2 3.8.2 step 4's message. */
export function blockedMessage(port: number | null): string {
  const which = port === null ? "UI port" : `UI port ${String(port)}`;
  return (
    `Another user account on this machine holds or recently held ${PRODUCT_NAME}'s ${which}. ` +
    `${PRODUCT_NAME} signed out every browser and will not serve its UI there. Close all ` +
    `${PRODUCT_NAME} tabs and app windows, then run \`${CLI_NAME} service port <n>\`.`
  );
}

/** A2 3.8.2 step 6's line for `ttasks open`. */
export function movedMessage(persisted: number, port: number): string {
  return `Port ${String(persisted)} is busy, using ${String(port)} this time. The installed web app needs port ${String(persisted)}.`;
}

/** A first start whose port could not be written to machine.toml: the page works this run. */
export function unsavedMessage(port: number): string {
  return `Port ${String(port)} could not be saved to machine.toml, so the next start may use another one. To save it: ${CLI_NAME} service port ${String(port)}`;
}

/** Whether the listener runs on a port that machine.toml does not hold, as status reports it. */
export function portUnsaved(http: {
  readonly port?: number | null;
  readonly persisted?: number | null;
  readonly moved?: boolean;
  readonly blocked?: string | null;
}): boolean {
  return (
    typeof http.port === "number" &&
    http.persisted === null &&
    http.moved !== true &&
    (http.blocked ?? null) === null
  );
}
