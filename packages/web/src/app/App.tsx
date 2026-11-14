// The signed-in page: the router inside the browser's sign-in and the theme. When the service
// refuses the token, the page forgets it and shows the signed-out page (A2 3.8.4 step 5).
import { RouterProvider } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { useT } from "../i18n/intl.tsx";
import { keepToken, type TokenStore } from "../stored.ts";
import { applyTheme, keepTheme, readTheme, type ThemeChoice } from "../theme/preference.ts";
import css from "./App.module.css";
import { router } from "./router.tsx";
import { AuthContext, type Auth } from "./session.tsx";
import { ThemeContext, type ThemeControl } from "./Settings.tsx";
import { classes } from "./css.ts";

const styles = classes(css, ["out"]);

/** The theme control: the stored choice, applied at once and kept. */
export function useThemeControl(store: TokenStore | undefined): ThemeControl {
  const [choice, setChoice] = useState<ThemeChoice>(() => readTheme(store));
  const choose = useCallback(
    (next: ThemeChoice) => {
      applyTheme(document.documentElement, next);
      keepTheme(store, next);
      setChoice(next);
    },
    [store],
  );
  return useMemo(() => ({ choice, choose }), [choice, choose]);
}

export function App({
  token,
  build,
  store,
}: {
  readonly token: string | null;
  readonly build: string;
  readonly store: TokenStore | undefined;
}) {
  const [out, setOut] = useState(token === null);
  const theme = useThemeControl(store);
  const signedOut = useCallback(() => {
    keepToken(store, null);
    setOut(true);
  }, [store]);
  const auth = useMemo<Auth | undefined>(
    () => (token === null ? undefined : { token, build, signedOut }),
    [token, build, signedOut],
  );
  if (out || auth === undefined) return <SignedOutPage />;
  return (
    <ThemeContext.Provider value={theme}>
      <AuthContext.Provider value={auth}>
        <RouterProvider router={router} />
      </AuthContext.Provider>
    </ThemeContext.Provider>
  );
}

/** The page a browser without a token sees (A2 3.8.4 step 5). */
export function SignedOutPage() {
  const t = useT();
  return (
    <main className={styles.out} data-phase="signed_out">
      <p>{t("app.signedOut")}</p>
    </main>
  );
}
