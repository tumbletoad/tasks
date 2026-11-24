// The page's folder and project writes: a new project with its folder, and setting or clearing a
// project's or a task's folder here. Each goes through folder.manage (or group.manage for a project
// without a folder) as the person, in turn with the page's other edits, and each is undone by its
// toast's Undo or by Ctrl+Z.
import { useContext, useMemo } from "react";
import type { Client } from "@ttasks/contracts/generated/client.ts";
import { Session } from "../context.ts";
import type { Edits, WriteReceipt } from "../edit/edits.ts";
import { useEdits } from "../edit/useEdits.ts";
import { useList } from "../i18n/intl.tsx";
import type { Msg } from "../row/model.ts";

type FolderInput = Omit<Parameters<Client["folder"]["manage"]>[0], "request_id">;
type FolderResult = Awaited<ReturnType<Client["folder"]["manage"]>>;
type GroupResult = Awaited<ReturnType<Client["group"]["manage"]>>;

/** A project's area as the write's answer gives it. */
export type WrittenArea = NonNullable<FolderResult["owner"]["area"]>;

/** What a write changed: an existing project of the folder, or the project or folder written. */
export interface Written {
  /** `exists`: another project has the folder here, and nothing was written. */
  readonly result: string;
  /** The project made or found; none when only the write's receipt answered. */
  readonly project?: { readonly id: string; readonly name: string };
  /** The project's area as of the write, as the service resolved it. */
  readonly area?: WrittenArea;
}

/** A new project in an archived area is out of sight: the caller says so, not an Undo toast. */
const hidden = (result: FolderResult | GroupResult | WriteReceipt): boolean =>
  !("receipt" in result) &&
  ("owner" in result ? result.owner.area : result.group?.area)?.archived === true;

/** At most this many folders that moved along or stayed are named in a toast. */
const NAMED = 3;

/** A folder write's toast that names no folder inside the old one. */
const NONE_INSIDE = {
  count: 0,
  names: "",
  stayed: 0,
  because: "",
  kept: "",
  also: "none",
} as const;

/** The folders a toast names: a task by its reference, a project by its name. */
function namesOf(list: FolderResult["followed"], count: number): string {
  const named = (list ?? []).slice(0, NAMED).map((f) => f.ref ?? f.name ?? "");
  return count > named.length ? `${named.join(", ")}, …` : named.join(", ");
}

/**
 * What the folder write did, what the folders inside the old one did, and the other projects with
 * the folder unless the dialog said so already (`told`), in the toast's words. A receipt says only
 * that it was written: the toast then says what was asked.
 */
function said(
  input: FolderInput,
  result: FolderResult | WriteReceipt,
  told: boolean,
  list: (items: readonly string[]) => string,
): Msg | undefined {
  if (result.result === "no_change" || result.result === "exists" || hidden(result)) {
    return undefined;
  }
  if ("receipt" in result) {
    if (input.action === "clear") return { id: "toast.folderCleared" };
    if (input.action === "add_project") {
      const own = (input.folder ?? "").split(/[\\/]/u).findLast((part) => part !== "");
      return {
        id: "toast.projectAdded",
        values: { name: input.project ?? own ?? "", also: "none" },
      };
    }
    return { id: "toast.folderSet", values: { ...NONE_INSIDE, folder: input.folder ?? "" } };
  }
  const others = told ? [] : (result.also ?? []).map((p) => p.name);
  const also = others.length === 0 ? "none" : list(others);
  if (input.action === "add_project") {
    return { id: "toast.projectAdded", values: { name: result.owner.name ?? "", also } };
  }
  if (result.result === "cleared") return { id: "toast.folderCleared" };
  const count = result.moved ?? 0;
  const stayed = result.stayed ?? 0;
  return {
    id: "toast.folderSet",
    values: {
      folder: result.folder ?? "",
      count,
      names: namesOf(result.followed, count),
      stayed,
      because: result.stayed_because ?? "",
      kept: namesOf(result.kept, stayed),
      also,
    },
  };
}

/** `base`: where the feed was when the folder shown was read, so a change made since is a conflict. */
export interface FolderWrites {
  setTask(task: { readonly ref: string }, folder: string, base?: string): Promise<Written>;
  clearTask(task: { readonly ref: string }, base?: string): Promise<Written>;
  /** `told`: the dialog said which other projects have the folder, so the toast does not. */
  setProject(project: string, folder: string, base?: string, told?: boolean): Promise<Written>;
  clearProject(project: string, base?: string): Promise<Written>;
  /** A project for `folder` (none: a project without a folder) in `area`: an area's ID, or a new area's name. */
  addProject(input: {
    readonly folder?: string;
    readonly name: string;
    readonly area: string;
    readonly told?: boolean;
  }): Promise<Written>;
}

export function folderWrites(
  client: Client,
  edits: Pick<Edits, "write">,
  list: (items: readonly string[]) => string,
): FolderWrites {
  const manage = (input: FolderInput, base?: string, told = false) =>
    edits
      .write(
        (request, sent) =>
          client.folder.manage({
            ...input,
            ...(sent === undefined ? {} : { base: sent }),
            request_id: request,
          }),
        (result) => said(input, result, told, list),
        { base },
      )
      .then((result): Written => ({
        result: result.result,
        ...("receipt" in result || result.owner.kind !== "project"
          ? {}
          : {
              project: { id: result.owner.id, name: result.owner.name ?? "" },
              ...(result.owner.area === undefined ? {} : { area: result.owner.area }),
            }),
      }));
  return {
    setTask: (task, folder, base) => manage({ action: "set", task: task.ref, folder }, base),
    clearTask: (task, base) => manage({ action: "clear", task: task.ref }, base),
    setProject: (project, folder, base, told) =>
      manage({ action: "set", project, folder }, base, told),
    clearProject: (project, base) => manage({ action: "clear", project }, base),
    addProject: ({ folder, name, area, told }) => {
      if (folder !== undefined) {
        return manage(
          {
            action: "add_project",
            folder,
            area,
            ...(name.trim() === "" ? {} : { project: name.trim() }),
          },
          undefined,
          told,
        );
      }
      // The area and the name together name the project; a slash would cut them apart.
      const path = `${area.replaceAll("/", " ")}/${name.trim().replaceAll("/", " ")}`;
      return edits
        .write(
          (request) =>
            client.group.manage({ action: "create", path, mode: "apply", request_id: request }),
          (result: GroupResult | WriteReceipt) =>
            !hidden(result) && (result.result === "created" || result.result === "updated")
              ? {
                  id: "toast.projectAdded",
                  values: {
                    name: ("receipt" in result ? undefined : result.group?.name) ?? name,
                    also: "none",
                  },
                }
              : undefined,
        )
        .then((result): Written => ({
          result: result.result ?? "",
          ...("receipt" in result || result.group?.kind !== "project"
            ? {}
            : {
                // An answer that could not read the name back names none: the one asked for.
                project: { id: result.group.id, name: result.group.name ?? name },
                ...(result.group.area === undefined ? {} : { area: result.group.area }),
              }),
        }));
    },
  };
}

export function useFolderWrites(): FolderWrites {
  const { api } = useContext(Session);
  const edits = useEdits();
  const list = useList();
  return useMemo(() => folderWrites(api.client, edits, list), [api, edits, list]);
}
