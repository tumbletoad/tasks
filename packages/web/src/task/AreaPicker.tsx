// The area and project control: a pill button with the area's dot that opens a
// type-ahead over the area tree. Typing filters the areas and their projects; the arrows move in
// the list while focus stays in the field, Enter or a click moves the task. The first choice is
// what Enter takes, so a live area whose name is close to what was typed comes first and a typo
// lands in the area meant. A name no area has is offered as a new area below it, and archived areas
// and projects come last, marked. Escape closes, and focus returns to the pill. A task leaves its
// area only for another one: `task.update` moves a task into an area or project, never out of every
// area.
import { type KeyboardEvent, useContext, useMemo, useState } from "react";
import {
  Autocomplete,
  Button,
  Dialog,
  DialogTrigger,
  Input,
  ListBox,
  ListBoxItem,
  Popover,
  SearchField,
  Text,
  useFilter,
} from "react-aria-components";
import { classes } from "../app/css.ts";
import { useToast } from "../app/frame.ts";
import { PlusIcon } from "../app/Icons.tsx";
import { Session } from "../context.ts";
import { groupingChange } from "../edit/change.ts";
import { useEdits } from "../edit/useEdits.ts";
import { refusalText } from "../folder/FolderDialog.tsx";
import { areaSlots } from "@ttasks/client/today";
import { useT } from "../i18n/intl.tsx";
import { useLive } from "../store/hooks.ts";
import { childrenOf, topLevel, trail, type TaskRow } from "@ttasks/client/store";
import { closeName, sameName } from "./areaNames.ts";
import css from "./Picker.module.css";

const styles = classes(css, [
  "pill",
  "empty",
  "popover",
  "dialog",
  "field",
  "list",
  "option",
  "dot",
  "mark",
]);

interface Choice {
  readonly id: string;
  readonly text: string;
  readonly area: { readonly id: string; readonly title: string };
  readonly project?: { readonly id: string; readonly title: string };
  readonly slot: number;
  /** An archived area, or a project archived or in an archived area. */
  readonly archived?: boolean;
}

/** The choice that makes a new area of what was typed. */
const NEW_AREA = "new-area";

/** An area's longest name. */
const AREA_NAME = 120;

export function AreaPicker({ task }: { readonly task: TaskRow }) {
  const t = useT();
  const say = useToast();
  const { api } = useContext(Session);
  const edits = useEdits();
  const state = useLive();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const { contains } = useFilter({ sensitivity: "base" });
  const slots = useMemo(() => areaSlots(state.nodes), [state.nodes]);
  const areas = useMemo(() => topLevel(state.nodes), [state.nodes]);
  const choices = useMemo(() => {
    const out: Choice[] = [];
    for (const area of areas) {
      const slot = slots.get(area.id) ?? 1;
      const a = { id: area.id, title: area.title };
      const shelved = area.state === "archived";
      out.push({ id: area.id, text: area.title, area: a, slot, archived: shelved });
      for (const project of childrenOf(state.nodes, area.id)) {
        out.push({
          id: project.id,
          text: t("fact.areaProject", { area: area.title, project: project.title }),
          area: a,
          project: { id: project.id, title: project.title },
          slot,
          archived: shelved || project.state === "archived",
        });
      }
    }
    return out;
  }, [state.nodes, areas, slots, t]);
  // A slash would make the name an area and a project.
  const name = typed.replaceAll("/", " ").trim();
  // The areas the name likely means are shown whatever the filter's spelling: the same name, then a
  // close one. The live ones come first; an archived one stays with the archived ones, last. A new
  // area is offered unless an area has the name, since making it would give that one.
  const near =
    name === ""
      ? []
      : [
          ...areas.filter((a) => sameName(a.title, name)),
          ...areas.filter((a) => closeName(a.title, name)),
        ];
  const meant = near.filter((a) => a.state !== "archived");
  const first = new Set(meant.map((a) => a.id));
  const listed = new Set(near.map((a) => a.id));
  const named = name !== "" && areas.some((a) => sameName(a.title, name));
  const items: readonly Choice[] = [
    ...meant.flatMap((a) => choices.find((c) => c.id === a.id) ?? []),
    ...choices.filter((c) => c.archived !== true && !first.has(c.id)),
    ...(name === "" || named
      ? []
      : [
          {
            id: NEW_AREA,
            text: t("area.new", { name }),
            area: { id: NEW_AREA, title: name },
            slot: 0,
          },
        ]),
    ...choices.filter((c) => c.archived === true),
  ];
  const filter = (text: string, input: string, node: { readonly key: unknown }) =>
    node.key === NEW_AREA || listed.has(String(node.key)) || contains(text, input);

  /**
   * Makes the area as the command line does, then moves the task into it from what the person saw
   * when they chose (`seen`): a filing made elsewhere meanwhile is a conflict, never overwritten.
   */
  const addArea = (title: string, seen: string | undefined) => {
    edits
      .write(
        (request) =>
          api.client.group.manage({
            action: "create",
            path: title,
            mode: "apply",
            request_id: request,
          }),
        // Known only from its receipt, the area is not named: the task stays, and the toast says so.
        (result) =>
          "receipt" in result ? { id: "area.added", values: { name: title } } : undefined,
        // The page has no way to take an area away.
        { undo: true },
      )
      .then(
        (result) => {
          const made = "receipt" in result ? undefined : result.group;
          if (made?.kind !== "area") return;
          // An answer that could not read the name back names none: the one typed.
          const name = made.name ?? title;
          // The new area is a step of its own, which the move must not end: Undo takes back the
          // move, and then the area.
          edits.edit(task, groupingChange({ id: made.id, title: name }, undefined), {
            base: seen,
            undo: true,
            refused: (why) => ({ id: "area.addedNotMoved", values: { name, why } }),
          });
        },
        (failed: unknown) => {
          say(refusalText(failed, t("area.notAdded")));
        },
      );
  };

  const [area, project] = trail(state.nodes, task.parent);
  const slot = area === undefined ? undefined : slots.get(area.id);
  const shown =
    area === undefined
      ? undefined
      : project === undefined
        ? area.title
        : t("fact.areaProject", { area: area.title, project: project.title });
  // A task stays in its area or project when that is archived: the pill says so.
  const shelved = [area, project].some((node) => node?.state === "archived");
  const current = task.parent;
  const take = (key: unknown) => {
    const choice = items.find((c) => c.id === key);
    const seen = edits.seen(task, ["grouping"]);
    setOpen(false);
    setTyped("");
    if (choice === undefined || choice.id === current) return;
    if (choice.id === NEW_AREA) addArea(choice.area.title, seen);
    else edits.edit(task, groupingChange(choice.area, choice.project));
  };
  // Enter takes the option drawn as highlighted. React Aria forwards it to an option it tracks
  // apart from the highlight, which a quick Down after typing leaves behind.
  const enter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    const dialog = e.currentTarget.closest('[role="dialog"]');
    const option = dialog?.querySelector('[role="option"][data-focused="true"]');
    if (option instanceof HTMLElement) take(option.dataset["key"]);
  };
  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        if (!isOpen) setTyped("");
      }}
    >
      <Button
        className={shown === undefined ? `${styles.pill} ${styles.empty}` : styles.pill}
        data-part="area"
        aria-label={t("fact.control", {
          label: t("fact.area"),
          value:
            shown === undefined
              ? t("fact.noArea")
              : shelved
                ? t("area.archivedName", { name: shown })
                : shown,
        })}
      >
        {area === undefined ? null : (
          <span className={`${styles.dot} slot-${String(slot ?? 1)}`} aria-hidden="true" />
        )}
        <span dir="auto">{shown ?? t("fact.noArea")}</span>
        {shelved ? (
          <span className={styles.mark} aria-hidden="true">
            {t("area.archived")}
          </span>
        ) : null}
      </Button>
      <Popover className={styles.popover} placement="bottom start">
        <Dialog className={styles.dialog} aria-label={t("area.label")}>
          <Autocomplete filter={filter} inputValue={typed} onInputChange={setTyped}>
            <SearchField aria-label={t("area.search")} autoFocus>
              <Input
                className={styles.field}
                placeholder={t("area.search")}
                maxLength={AREA_NAME}
                onKeyDownCapture={enter}
              />
            </SearchField>
            <ListBox
              className={styles.list}
              aria-label={t("area.label")}
              items={items}
              renderEmptyState={() => t("area.empty")}
              onAction={take}
            >
              {(choice) => (
                <ListBoxItem
                  id={choice.id}
                  textValue={choice.text}
                  className={styles.option}
                  data-current={choice.id === current || undefined}
                  data-part={choice.id === NEW_AREA ? "new-area" : undefined}
                >
                  {choice.id === NEW_AREA ? (
                    <PlusIcon />
                  ) : (
                    <span
                      className={`${styles.dot} slot-${String(choice.slot)}`}
                      aria-hidden="true"
                    />
                  )}
                  <Text slot="label" dir="auto">
                    {choice.text}
                  </Text>
                  {/* Always there, so an area archived while the list is open is described too. */}
                  <Text slot="description" className={styles.mark}>
                    {choice.archived === true ? t("area.archived") : ""}
                  </Text>
                </ListBoxItem>
              )}
            </ListBox>
          </Autocomplete>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
