// Who joins a space, by the rules both writers keep: the space's person is the one human actor, an
// agent joins by its label, and only the space's authority registers anyone.
import { misuse, StorageError } from "../errors.ts";
import { isId, type Id } from "../ids.ts";
import { isSpaceName } from "../rows.ts";
import { normaliseStored } from "./request.ts";

/** An agent's label as its actor row keeps it: one line of 1 to 100 characters, stored as given. */
export function agentLabel(label: string): string {
  const name = normaliseStored(label);
  if (!isSpaceName(name) || name !== label) {
    throw misuse("An actor label is one line of 1 to 100 characters");
  }
  return name;
}

/** The space's person, which every space has. */
export function spaceHuman(id: unknown): Id<"ac"> {
  if (!isId(id, "ac")) throw new StorageError("SPACE_INVALID", "The space has no human actor");
  return id;
}

/** What another machine than the space's authority meets when it would register an actor. */
export const notTheAuthority = (): StorageError =>
  new StorageError("STORAGE_READ_ONLY", "Another machine is this space's authority");
