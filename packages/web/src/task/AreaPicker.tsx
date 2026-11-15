// The area and project control (A5 3.7, 3.11): a pill button with the area's dot that opens a
// type-ahead over the area tree. Typing filters the areas and their projects; the arrows move in
// the list while focus stays in the field, Enter or a click moves the task. Escape closes, and
// focus returns to the pill. A task leaves its area only for another one: `task.update` moves a
// task into an area or project, never out of every area.
import { useMemo, useState } from "react";
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
  useFilter,
} from "react-aria-components";
import { classes } from "../app/css.ts";
import { groupingChange } from "../edit/change.ts";
import { useEdits } from "../edit/useEdits.ts";
import { areaSlots } from "../groups.ts";
import { useT } from "../i18n/intl.tsx";
import { useLive } from "../store/hooks.ts";
import type { TaskRow } from "../store/rows.ts";
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
]);

interface Choice {
  readonly id: string;
  readonly text: string;
  readonly area: { readonly id: string; readonly title: string };
  readonly project?: { readonly id: string; readonly title: string };
  readonly slot: number;
}

const byPosition = <T extends { position: string }>(a: T, b: T) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : 0;

export function AreaPicker({ task }: { readonly task: TaskRow }) {
  const t = useT();
  const edits = useEdits();
  const state = useLive();
  const [open, setOpen] = useState(false);
  const { contains } = useFilter({ sensitivity: "base" });
  const slots = useMemo(() => areaSlots(state.areas.values()), [state.areas]);
  const choices = useMemo(() => {
    const out: Choice[] = [];
    const projects = [...state.projects.values()].sort(byPosition);
    for (const area of [...state.areas.values()].sort(byPosition)) {
      const slot = slots.get(area.id) ?? 1;
      const a = { id: area.id, title: area.title };
      out.push({ id: area.id, text: area.title, area: a, slot });
      for (const project of projects) {
        if (project.area_id !== area.id) continue;
        out.push({
          id: project.id,
          text: t("fact.areaProject", { area: area.title, project: project.title }),
          area: a,
          project: { id: project.id, title: project.title },
          slot,
        });
      }
    }
    return out;
  }, [state.areas, state.projects, slots, t]);

  const area = task.area_id === undefined ? undefined : state.areas.get(task.area_id);
  const project = task.project_id === undefined ? undefined : state.projects.get(task.project_id);
  const slot = area === undefined ? undefined : slots.get(area.id);
  const shown =
    area === undefined
      ? undefined
      : project === undefined
        ? area.title
        : t("fact.areaProject", { area: area.title, project: project.title });
  const current = task.project_id ?? task.area_id;
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button
        className={shown === undefined ? `${styles.pill} ${styles.empty}` : styles.pill}
        data-part="area"
        aria-label={t("fact.control", { label: t("fact.area"), value: shown ?? t("fact.noArea") })}
      >
        {area === undefined ? null : (
          <span className={`${styles.dot} slot-${String(slot ?? 1)}`} aria-hidden="true" />
        )}
        <span dir="auto">{shown ?? t("fact.noArea")}</span>
      </Button>
      <Popover className={styles.popover} placement="bottom start">
        <Dialog className={styles.dialog} aria-label={t("area.label")}>
          <Autocomplete filter={contains}>
            <SearchField aria-label={t("area.search")} autoFocus>
              <Input className={styles.field} placeholder={t("area.search")} />
            </SearchField>
            <ListBox
              className={styles.list}
              aria-label={t("area.label")}
              items={choices}
              renderEmptyState={() => t("area.empty")}
              onAction={(key) => {
                const choice = choices.find((c) => c.id === key);
                setOpen(false);
                if (choice === undefined || choice.id === current) return;
                edits.edit(task, groupingChange(choice.area, choice.project));
              }}
            >
              {(choice) => (
                <ListBoxItem
                  id={choice.id}
                  textValue={choice.text}
                  className={styles.option}
                  data-current={choice.id === current || undefined}
                >
                  <span
                    className={`${styles.dot} slot-${String(choice.slot)}`}
                    aria-hidden="true"
                  />
                  <span dir="auto">{choice.text}</span>
                </ListBoxItem>
              )}
            </ListBox>
          </Autocomplete>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
