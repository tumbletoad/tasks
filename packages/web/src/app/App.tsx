// The signed-in page: the router inside the browser's sign-in and this computer's settings. When
// the service refuses the token, the page forgets it and shows the signed-out page (A2 3.8.4
// step 5).
import { RouterProvider } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { Api } from "../api.ts";
import { useT } from "../i18n/intl.tsx";
import { keepToken, type TokenStore } from "../stored.ts";
import css from "./App.module.css";
import { MachineContext, useMachineControl } from "./machine.ts";
import { router } from "./router.tsx";
import { AuthContext, type Auth } from "./session.tsx";
import { classes } from "./css.ts";

const styles = classes(css, ["out"]);

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
  const api = useMemo(
    () => (token === null ? undefined : new Api(token, build, () => undefined)),
    [token, build],
  );
  const machine = useMachineControl(out ? undefined : api, store);
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
    <MachineContext.Provider value={machine}>
      <AuthContext.Provider value={auth}>
        <RouterProvider router={router} />
      </AuthContext.Provider>
    </MachineContext.Provider>
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
