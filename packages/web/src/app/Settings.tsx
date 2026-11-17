// Settings: how Tasks behaves for the person on this computer, one short page. Every control
// changes something at once and can go back to its default; the page says once that all of it is
// kept for this computer, the same in every space and browser here. Only what works is here.
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Heading,
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
  SwitchButton,
  SwitchField,
  Text,
} from "react-aria-components";
import { Refused, type TerminalView } from "../api.ts";
import { useT, type MessageId, type Translate } from "../i18n/intl.tsx";
import { useSheet } from "../keys/Sheet.tsx";
import { useKeyLabel } from "../keys/labels.ts";
import { isThemeChoice, THEME_CHOICES, type ThemeChoice } from "../theme/preference.ts";
import { useTitle, useToast } from "./frame.ts";
import { useMachine } from "./machine.ts";
import css from "./Settings.module.css";
import { classes } from "./css.ts";

const styles = classes(css, [
  "button",
  "description",
  "dot",
  "group",
  "heading",
  "label",
  "name",
  "note",
  "option",
  "options",
  "section",
  "settings",
  "status",
  "switch",
  "thumb",
  "track",
  "where",
]);

const LABELS: Readonly<Record<ThemeChoice, readonly [MessageId, MessageId]>> = {
  sumi: ["settings.sumi", "settings.sumiNote"],
  washi: ["settings.washi", "settings.washiNote"],
  system: ["settings.system", "settings.systemNote"],
};

/** An adapter's word as the catalogue's select takes it. */
const word = (app: string) => app.replaceAll("-", "_");

/**
 * Why a setting was not saved: machine.toml changed meanwhile, a terminal went away or the network
 * failed, and trying again helps; any other refusal is machine.toml's, and trying again does not.
 */
const failure = (error: unknown): MessageId =>
  error instanceof Refused && error.code !== "conflict" && error.code !== "not_found"
    ? "settings.fileProblem"
    : "settings.failed";

export function SettingsPage() {
  const t = useT();
  useTitle(t("nav.settings"));
  return (
    <div className={styles.settings}>
      <p className={styles.where}>{t("settings.where")}</p>
      <Appearance />
      <Keyboard />
      <Terminal />
    </div>
  );
}

function Appearance() {
  const t = useT();
  const say = useToast();
  const machine = useMachine();
  return (
    <section className={styles.section}>
      <Heading level={2} className={styles.heading}>
        {t("settings.appearance")}
      </Heading>
      <RadioGroup
        className={styles.group}
        value={machine.theme}
        onChange={(value) => {
          if (isThemeChoice(value)) {
            machine.setTheme(value).catch((error: unknown) => {
              say(t(failure(error)));
            });
          }
        }}
      >
        <Label className={styles.label}>{t("settings.theme")}</Label>
        <div className={styles.options}>
          {THEME_CHOICES.map((choice) => {
            const [name, note] = LABELS[choice];
            return (
              <RadioField key={choice} value={choice}>
                <RadioButton className={styles.option}>
                  <span className={styles.dot} aria-hidden="true" />
                  <span className={styles.name}>{t(name)}</span>
                  <span className={styles.note}>{t(note)}</span>
                </RadioButton>
              </RadioField>
            );
          })}
        </div>
      </RadioGroup>
    </section>
  );
}

function Keyboard() {
  const t = useT();
  const say = useToast();
  const machine = useMachine();
  const sheet = useSheet();
  const label = useKeyLabel();
  return (
    <section className={styles.section}>
      <Heading level={2} className={styles.heading}>
        {t("settings.keyboard")}
      </Heading>
      <SwitchField
        isSelected={machine.singleKeys}
        aria-describedby="settings-single-keys"
        onChange={(on) => {
          machine.setSingleKeys(on).catch((error: unknown) => {
            say(t(failure(error)));
          });
        }}
      >
        <SwitchButton className={styles.switch}>
          <span className={styles.track} aria-hidden="true">
            <span className={styles.thumb} />
          </span>
          <span className={styles.name}>{t("settings.singleKeys")}</span>
        </SwitchButton>
      </SwitchField>
      <p id="settings-single-keys" className={styles.description}>
        {t("settings.singleKeysNote", { search: label({ key: "k", mod: true }) })}
      </p>
      <Button className={styles.button} onPress={sheet.open}>
        {t("settings.showKeys")}
      </Button>
    </section>
  );
}

/** What the page says of Open's terminal: which one, why, and what went wrong with the default. */
function terminalStatus(t: Translate, view: TerminalView): string[] {
  const used = view.used;
  if (used === null) return [t("settings.terminalNone")];
  const terminal = t("settings.terminalName", { terminal: word(used.app) });
  if (!used.found) return [t("settings.terminalMissing", { terminal })];
  const lines = [t("settings.terminalUsed", { terminal, source: used.source })];
  if (view.unread !== null) lines.push(t("settings.terminalUnread"));
  else if (view.unsupported !== null) lines.push(t("settings.terminalUnsupported"));
  return lines;
}

function Terminal() {
  const t = useT();
  const say = useToast();
  const { api } = useMachine();
  const [view, setView] = useState<TerminalView | null | undefined>(undefined);
  /** The choice on its way: shown until the service answers. */
  const [choosing, setChoosing] = useState<string | undefined>(undefined);

  const read = useCallback(() => {
    if (api === undefined) return;
    api.terminal().then(setView, () => undefined);
  }, [api]);
  // Machine.toml may change in another tab or by hand: read again when the page comes back.
  useEffect(() => {
    read();
    window.addEventListener("focus", read);
    return () => {
      window.removeEventListener("focus", read);
    };
  }, [read]);

  if (view === undefined || view === null || api === undefined) return null;
  const options = ["auto", ...view.installed];
  // A terminal machine.toml names that is not found here stays visible, chosen.
  if (!options.includes(view.chosen)) options.push(view.chosen);
  return (
    <section className={styles.section}>
      <Heading level={2} className={styles.heading}>
        {t("settings.open")}
      </Heading>
      <RadioGroup
        className={styles.group}
        value={choosing ?? view.chosen}
        onChange={(app) => {
          setChoosing(app);
          api
            .terminal(app)
            .then(
              (next) => {
                setView(next);
              },
              (error: unknown) => {
                say(t(failure(error)));
                // The terminals found may have changed since the page read them.
                read();
              },
            )
            .finally(() => {
              setChoosing(undefined);
            });
        }}
      >
        <Label className={styles.label}>{t("settings.terminal")}</Label>
        <div className={styles.options}>
          {options.map((app) => (
            <RadioField key={app} value={app}>
              <RadioButton className={styles.option}>
                <span className={styles.dot} aria-hidden="true" />
                <span className={styles.name}>
                  {app === "auto"
                    ? t("settings.terminalDefault")
                    : t("settings.terminalName", { terminal: word(app) })}
                </span>
              </RadioButton>
            </RadioField>
          ))}
        </div>
        <Text slot="description" className={styles.status}>
          {terminalStatus(t, view).join(" ")}
        </Text>
      </RadioGroup>
    </section>
  );
}
