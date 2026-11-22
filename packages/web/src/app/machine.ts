// This machine's settings of the page, as every component reads them: the theme and whether
// single-letter keys work. The service keeps them (machine.toml) and the feed brings each change,
// so every tab and every browser on this machine follows. A change applies here at once and goes
// to the service; when the service refuses it, the page goes back to what the service holds.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Api } from "../api.ts";
import type { TokenStore } from "../stored.ts";
import type { MachinePreference } from "../store/rows.ts";
import {
  applyTheme,
  forgetLegacyTheme,
  isThemeChoice,
  legacyTheme,
  servedTheme,
  type ThemeChoice,
} from "../theme/preference.ts";

export interface MachineSettings {
  readonly theme: ThemeChoice;
  readonly singleKeys: boolean;
}

export interface MachineControl extends MachineSettings {
  /** Resolves once the service kept it; rejects when it did not, and the page shows the old one. */
  setTheme(choice: ThemeChoice): Promise<void>;
  setSingleKeys(on: boolean): Promise<void>;
  /** The feed's `machine` message. */
  receive(preferences: readonly MachinePreference[]): void;
  /** The calls that name no space: Open's terminal. None on a page without a sign-in. */
  readonly api: Api | undefined;
}

const DEFAULTS: MachineSettings = { theme: "sumi", singleKeys: true };

export const MachineContext = createContext<MachineControl>({
  ...DEFAULTS,
  setTheme: () => Promise.resolve(),
  setSingleKeys: () => Promise.resolve(),
  receive: () => undefined,
  api: undefined,
});

export const useMachine = (): MachineControl => useContext(MachineContext);

type Key = "ui.theme" | "ui.single_keys";

/** What a `machine` message says, each value checked by its shape. */
function settingsOf(
  preferences: readonly MachinePreference[],
  before: MachineSettings,
): MachineSettings & { readonly themeChosen: boolean } {
  const theme = preferences.find((p) => p.key === "ui.theme");
  const keys = preferences.find((p) => p.key === "ui.single_keys");
  return {
    theme: isThemeChoice(theme?.value) ? theme.value : before.theme,
    singleKeys: typeof keys?.value === "boolean" ? keys.value : before.singleKeys,
    themeChosen: theme?.state === "set",
  };
}

export function useMachineControl(
  api: Api | undefined,
  store: TokenStore | undefined,
): MachineControl {
  const [shown, setShown] = useState<MachineSettings>(() => ({
    ...DEFAULTS,
    theme: servedTheme(document.documentElement),
  }));
  /** What the service holds, as its last message said. */
  const held = useRef<MachineSettings | undefined>(undefined);
  /** Changes on their way, per key: until they settle, the feed's older word does not show. */
  const pending = useRef(new Map<Key, number>());
  /** The newest change per key: only its answer says what stands, as answers may cross. */
  const newest = useRef(new Map<Key, number>());
  /** An older build's choice in this browser, handed over at the first message. */
  const legacy = useRef(legacyTheme(store));

  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    applyTheme(document.documentElement, shown.theme);
  }, [shown.theme]);

  const settle = useCallback(() => {
    const now = held.current;
    if (now === undefined) return;
    setShown((before) => ({
      theme: (pending.current.get("ui.theme") ?? 0) > 0 ? before.theme : now.theme,
      singleKeys:
        (pending.current.get("ui.single_keys") ?? 0) > 0 ? before.singleKeys : now.singleKeys,
    }));
  }, []);

  const write = useCallback(
    async <F extends keyof MachineSettings>(key: Key, field: F, value: MachineSettings[F]) => {
      if (api === undefined) throw new Error("No sign-in");
      const before = shownRef.current[field];
      pending.current.set(key, (pending.current.get(key) ?? 0) + 1);
      const mine = (newest.current.get(key) ?? 0) + 1;
      newest.current.set(key, mine);
      setShown((s) => ({ ...s, [field]: value }));
      try {
        const kept = await api.setMachinePreference(key, value);
        // The answer is the service's word too: the feed's message for it may come after it, or,
        // with the feed down, only at the next connection.
        const now = held.current;
        if (now !== undefined && newest.current.get(key) === mine) {
          const { theme, singleKeys } = settingsOf([kept], now);
          held.current = { theme, singleKeys };
        }
      } catch (error) {
        // Refused before the service ever said what it holds: back to what was shown.
        if (held.current === undefined) setShown((s) => ({ ...s, [field]: before }));
        throw error;
      } finally {
        pending.current.set(key, (pending.current.get(key) ?? 1) - 1);
        settle();
      }
    },
    [api, settle],
  );

  const setTheme = useCallback((theme: ThemeChoice) => write("ui.theme", "theme", theme), [write]);
  const setSingleKeys = useCallback(
    (on: boolean) => write("ui.single_keys", "singleKeys", on),
    [write],
  );

  const receive = useCallback(
    (preferences: readonly MachinePreference[]) => {
      const next = settingsOf(preferences, held.current ?? DEFAULTS);
      held.current = next;
      settle();
      const old = legacy.current;
      if (old === undefined) return;
      legacy.current = undefined;
      if (next.themeChosen) {
        forgetLegacyTheme(store);
        return;
      }
      setTheme(old).then(
        () => {
          forgetLegacyTheme(store);
        },
        () => undefined,
      );
    },
    [settle, setTheme, store],
  );

  return useMemo(
    () => ({ ...shown, setTheme, setSingleKeys, receive, api }),
    [shown, setTheme, setSingleKeys, receive, api],
  );
}
