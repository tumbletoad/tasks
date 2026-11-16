// The space switcher (A5 3.3): the space's name and a chevron, which open a small popover with the
// spaces on this machine. Choosing one navigates this tab only: its route takes the new space, the
// tab takes a fresh snapshot and moves its feed to it, and every other tab keeps its own space,
// view, feed and drafts. Each space has Make default, and the machine's default carries a mark.
// The default decides only what a new tab (`/`) and an unbound CLI call open.
//
// "New space" and "Open folder" need a folder picker and the space verbs over HTTP; they arrive with
// first-run setup (M5.12). Until then the CLI makes and opens spaces.
import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { SignedOut } from "../api.ts";
import { useT } from "../i18n/intl.tsx";
import { useToast } from "./frame.ts";
import { CheckIcon, ChevronIcon } from "./Icons.tsx";
import { useAuth, useMachineApi } from "./session.tsx";
import { NotOpenNotes } from "./NotOpen.tsx";
import { isServed, listSpaces, makeDefault, notOpen, type SpaceList } from "./spaces.ts";
import css from "./SpaceSwitcher.module.css";
import { LANDING } from "./views.ts";
import { classes } from "./css.ts";

const styles = classes(css, [
  "default",
  "dialog",
  "make",
  "mark",
  "name",
  "note",
  "pick",
  "popover",
  "space",
  "spaces",
  "state",
  "title",
  "trigger",
]);

export function SpaceSwitcher({
  space,
  name,
}: {
  readonly space: string;
  readonly name: string | undefined;
}) {
  const t = useT();
  const api = useMachineApi();
  const auth = useAuth();
  const say = useToast();
  const [list, setList] = useState<SpaceList | "failed" | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);

  const failed = useCallback(
    (error: unknown): boolean => {
      if (error instanceof SignedOut) {
        auth.signedOut();
        return true;
      }
      return false;
    },
    [auth],
  );

  const load = useCallback(() => {
    listSpaces(api).then(setList, (error: unknown) => {
      if (!failed(error)) setList("failed");
    });
  }, [api, failed]);

  const make = (id: string, title: string) => {
    setBusy(id);
    makeDefault(api, id)
      .then(
        () => {
          say(t("space.madeDefault", { name: title }));
          load();
        },
        (error: unknown) => {
          if (!failed(error)) say(t("space.defaultFailed"));
        },
      )
      .finally(() => {
        setBusy(undefined);
      });
  };

  return (
    <DialogTrigger
      onOpenChange={(open) => {
        if (open) load();
      }}
    >
      <Button className={styles.trigger} aria-label={t("space.switch", { name: name ?? "" })}>
        <span className={styles.name} dir="auto">
          {name ?? ""}
        </span>
        <ChevronIcon />
      </Button>
      <Popover className={styles.popover} placement="bottom start" offset={4}>
        <Dialog className={styles.dialog} aria-label={t("space.list")}>
          {({ close }) =>
            list === "failed" ? (
              <p className={styles.note}>{t("space.listFailed")}</p>
            ) : (
              <>
                <ul className={styles.spaces}>
                  {(list?.spaces ?? []).map((item) => {
                    const current = item.id === space;
                    const isDefault = list?.default === item.id;
                    const served = isServed(item);
                    return (
                      <li key={item.id} className={styles.space}>
                        {served ? (
                          <Link
                            to="/s/$space/$view"
                            params={{ space: item.id, view: LANDING }}
                            className={styles.pick}
                            {...(current ? { "aria-current": "page" as const } : {})}
                            onClick={close}
                          >
                            <span className={styles.mark}>{current ? <CheckIcon /> : null}</span>
                            <span className={styles.title} dir="auto">
                              {item.name}
                            </span>
                            {item.state === "read_only" ? (
                              <span className={styles.state}>{t("space.readOnly")}</span>
                            ) : null}
                          </Link>
                        ) : (
                          <span className={styles.pick} data-disabled="true">
                            <span className={styles.mark} />
                            <span className={styles.title} dir="auto">
                              {item.name}
                            </span>
                            <span className={styles.state}>{t("space.unavailable")}</span>
                          </span>
                        )}
                        {isDefault ? (
                          <span className={styles.default}>{t("space.default")}</span>
                        ) : (
                          <Button
                            className={styles.make}
                            isDisabled={busy !== undefined}
                            aria-label={t("space.makeDefaultFor", { name: item.name })}
                            onPress={() => {
                              make(item.id, item.name);
                            }}
                          >
                            {t("space.makeDefault")}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {list === undefined ? null : (
                  <NotOpenNotes spaces={notOpen(list)} className={styles.note} />
                )}
              </>
            )
          }
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
