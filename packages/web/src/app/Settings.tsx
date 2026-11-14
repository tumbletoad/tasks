// Settings (A5 3.18) holds one section until M5.11 builds the rest: Appearance, the theme (A5
// 3.19). Sumi, Washi, or System, which follows this computer's light or dark mode live. The choice
// applies at once, without a reload.
import { createContext, useContext } from "react";
import { Label, RadioButton, RadioField, RadioGroup } from "react-aria-components";
import { useT, type MessageId } from "../i18n/intl.tsx";
import { THEME_CHOICES, type ThemeChoice } from "../theme/preference.ts";
import { useTitle } from "./frame.ts";
import css from "./Settings.module.css";
import { classes } from "./css.ts";

const styles = classes(css, [
  "dot",
  "group",
  "label",
  "name",
  "note",
  "option",
  "options",
  "settings",
]);

export const SETTINGS_SECTIONS = ["appearance"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export interface ThemeControl {
  readonly choice: ThemeChoice;
  readonly choose: (choice: ThemeChoice) => void;
}

export const ThemeContext = createContext<ThemeControl>({
  choice: "sumi",
  choose: () => undefined,
});

const LABELS: Readonly<Record<ThemeChoice, readonly [MessageId, MessageId]>> = {
  sumi: ["settings.sumi", "settings.sumiNote"],
  washi: ["settings.washi", "settings.washiNote"],
  system: ["settings.system", "settings.systemNote"],
};

const isChoice = (value: string): value is ThemeChoice =>
  (THEME_CHOICES as readonly string[]).includes(value);

export function SettingsPage({ section }: { readonly section: SettingsSection }) {
  const t = useT();
  const theme = useContext(ThemeContext);
  useTitle(t("nav.settings"));
  return (
    <div className={styles.settings} data-section={section}>
      <RadioGroup
        className={styles.group}
        value={theme.choice}
        onChange={(value) => {
          if (isChoice(value)) theme.choose(value);
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
    </div>
  );
}
