// The app's one screen in this first step: the space this phone was paired for and whether the
// link to the computer is up. A cold start shows the saved space at once, with Connecting until
// a fresh hello.
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { PRODUCT_NAME } from "@ttasks/brand";
import { openLink, readSaved } from "./link/open.ts";
import { native } from "./link/socket.ts";

type State = "unpaired" | "connecting" | "connected" | "offline" | "removed";

const SAYS: Record<State, string> = {
  unpaired: "Not paired with a computer.",
  connecting: "Connecting…",
  connected: "Connected",
  offline: "Can't reach the computer.",
  removed: "This phone was removed on the computer.",
};

export function App() {
  const [saved] = useState(() => readSaved(native.pairing()));
  const [state, setState] = useState<State>(saved === undefined ? "unpaired" : "connecting");
  const [name, setName] = useState(saved?.space.name);

  useEffect(() => {
    if (saved === undefined) return;
    let close: (() => void) | undefined;
    let live = true;
    void openLink(saved).then((opened) => {
      if (!live) {
        if (opened.kind === "served") opened.socket.close();
        return;
      }
      if (opened.kind !== "served") {
        setState(opened.kind);
        return;
      }
      setName(opened.hello.link.space.name);
      setState("connected");
      close = () => {
        opened.socket.close();
      };
      opened.socket.events = {
        open: () => undefined,
        message: () => undefined,
        error: () => undefined,
        close: () => {
          setState("offline");
        },
      };
    });
    return () => {
      live = false;
      close?.();
    };
  }, [saved]);

  return (
    <View style={styles.screen}>
      <Text style={styles.space}>{name ?? PRODUCT_NAME}</Text>
      <Text style={styles.state}>{SAYS[state]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 },
  space: { fontSize: 28, fontWeight: "600" },
  state: { fontSize: 16 },
});
