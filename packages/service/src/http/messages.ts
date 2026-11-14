// The lines a person reads about the UI's port (A2 3.8.2), the same in `tasks open`, `tasks
// service status` and doctor. Storage-free, so the CLI imports them (`@tasks/service/http/shared`).
import { CLI_NAME, PRODUCT_NAME } from "@tasks/brand";

/** A2 3.8.2 step 4's message. */
export function blockedMessage(port: number | null): string {
  const which = port === null ? "UI port" : `UI port ${String(port)}`;
  return (
    `Another user account on this machine holds or recently held ${PRODUCT_NAME}'s ${which}. ` +
    `${PRODUCT_NAME} signed out every browser and will not serve its UI there. Close all ` +
    `${PRODUCT_NAME} tabs and app windows, then run \`${CLI_NAME} service port <n>\`.`
  );
}

/** A2 3.8.2 step 6's line for `tasks open`. */
export function movedMessage(persisted: number, port: number): string {
  return `Port ${String(persisted)} is busy, using ${String(port)} this time. The installed web app needs port ${String(persisted)}.`;
}
