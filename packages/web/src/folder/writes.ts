// The page's folder and project writes: a new project with its folder, and setting or clearing a
// project's or a task's folder here. Each goes through folder.manage (or group.manage for a project
// without a folder) as the person, in turn with the page's other edits, and each is undone by its
// toast's Undo or by Ctrl+Z.
import { useContext, useMemo } from "react";
import type { Client } from "@tasks/contracts/generated/client.ts";
import { Session } from "../context.ts";
import type { Edits } from "../edit/edits.ts";
import { useEdits } from "../edit/useEdits.ts";
import type { Msg } from "../row/model.ts";

type FolderResult = Awaited<ReturnType<Client["folder"]["manage"]>>;
type GroupResult = Awaited<ReturnType<Client["group"]["manage"]>>;

/** What a write changed: an existing project of the folder, or the project or folder written. */
export interface Written {
  /** `exists`: another project has the folder here, and nothing was written. */
  readonly result: string;
  /** The project made or found. */
  readonly project?: { readonly id: string; readonly name: string };
}

/** At most this many folders that moved along or stayed are named in a toast. */
const NAMED = 3;

/** The folders a toast names: a task by its reference, a project by its name. */
function namesOf(list: FolderResult["followed"], count: number): string {
  const named = (list ?? []).slice(0, NAMED).map((f) => f.ref ?? f.name ?? "");
  return count > named.length ? `${named.join(", ")}, …` : named.join(", ");
}

/** What the folder write did, and what the folders inside the old one did, in the toast's words. */
function setSaid(result: FolderResult): Msg | undefined {
  if (result.result === "no_change") return undefined;
  if (result.result === "cleared") return { id: "toast.folderCleared" };
  const folder = result.folder ?? "";
  if (result.stayed !== undefined) {
    const names = namesOf(result.kept, result.stayed);
    return { id: "toast.folderSetStayed", values: { folder, count: result.stayed, names } };
  }
  const count = result.moved ?? 0;
  return {
    id: "toast.folderSet",
    values: { folder, count, names: namesOf(result.followed, count) },
  };
}

export interface FolderWrites {
  setTask(task: { readonly ref: string }, folder: string): Promise<Written>;
  clearTask(task: { readonly ref: string }): Promise<Written>;
  setProject(project: string, folder: string): Promise<Written>;
  clearProject(project: string): Promise<Written>;
  /** A project for `folder` (none: a project without a folder) in the area named `area`. */
  addProject(input: {
    readonly folder?: string;
    readonly name: string;
    readonly area: string;
  }): Promise<Written>;
}

export function folderWrites(client: Client, edits: Pick<Edits, "write">): FolderWrites {
  const manage = (input: Omit<Parameters<Client["folder"]["manage"]>[0], "request_id">) =>
    edits
      .write(
        (request, base) =>
          client.folder.manage({
            ...input,
            ...(base === undefined ? {} : { base }),
            request_id: request,
          }),
        (result: FolderResult) =>
          input.action === "add_project"
            ? result.result === "created"
              ? { id: "toast.projectAdded", values: { name: result.owner.name ?? "" } }
              : undefined
            : setSaid(result),
      )
      .then((result): Written => ({
        result: result.result,
        ...(result.owner.kind === "project"
          ? { project: { id: result.owner.id, name: result.owner.name ?? "" } }
          : {}),
      }));
  return {
    setTask: (task, folder) => manage({ action: "set", task: task.ref, folder }),
    clearTask: (task) => manage({ action: "clear", task: task.ref }),
    setProject: (project, folder) => manage({ action: "set", project, folder }),
    clearProject: (project) => manage({ action: "clear", project }),
    addProject: ({ folder, name, area }) => {
      if (folder !== undefined) {
        return manage({
          action: "add_project",
          folder,
          area,
          ...(name.trim() === "" ? {} : { project: name.trim() }),
        });
      }
      // The area and the name together name the project; a slash would cut them apart.
      const path = `${area.replaceAll("/", " ")}/${name.trim().replaceAll("/", " ")}`;
      return edits
        .write(
          (request) =>
            client.group.manage({ action: "create", path, mode: "apply", request_id: request }),
          (result: GroupResult) =>
            result.result === "created"
              ? { id: "toast.projectAdded", values: { name: result.group?.name ?? name } }
              : undefined,
        )
        .then((result): Written => ({
          result: result.result ?? "",
          ...(result.group?.kind === "project"
            ? { project: { id: result.group.id, name: result.group.name } }
            : {}),
        }));
    },
  };
}

export function useFolderWrites(): FolderWrites {
  const { api } = useContext(Session);
  const edits = useEdits();
  return useMemo(() => folderWrites(api.client, edits), [api, edits]);
}
