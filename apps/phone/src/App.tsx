// The app: Today for the paired space, or the way to pair. Not paired: scan the code from
// Settings > Phones, name the phone, pair. Scan a new code from Today pairs again; a new pairing
// replaces the saved one only once it succeeded. Only the computer's `removed` forgets the pairing;
// a lost connection keeps it.
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { PRODUCT_NAME } from "@ttasks/brand";
import { readSaved, type Saved } from "@ttasks/client/link";
import type { Pairing } from "@ttasks/contracts/link";
import { native } from "./link/socket.ts";
import { Name, Scanner } from "./Pairing.tsx";
import { Today } from "./Today.tsx";
import { Button, shared, useColors } from "./ui.tsx";
import { WORDS } from "./words.ts";

type Screen =
  | { readonly kind: "unpaired" }
  | { readonly kind: "removed" }
  | { readonly kind: "paired"; readonly saved: Saved }
  /** `back`: where Cancel returns. */
  | { readonly kind: "scan"; readonly back: Screen }
  | { readonly kind: "name"; readonly qr: Pairing; readonly back: Screen };

export function App() {
  const [screen, setScreen] = useState<Screen>(() => {
    const saved = readSaved(native.pairing());
    return saved === undefined ? { kind: "unpaired" } : { kind: "paired", saved };
  });
  const colors = useColors();
  const scan = () => {
    setScreen({ kind: "scan", back: screen });
  };
  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      {screen.kind === "unpaired" || screen.kind === "removed" ? (
        <View style={shared.middle}>
          <Text style={[shared.title, { color: colors.text }]}>{PRODUCT_NAME}</Text>
          <Text style={[shared.body, { color: colors.text }]}>
            {screen.kind === "removed" ? WORDS.removed : WORDS.notPaired}
          </Text>
          <Text style={[shared.body, { color: colors.muted }]}>{WORDS.howToPair}</Text>
          <Button label={WORDS.scan} onPress={scan} colors={colors} primary />
        </View>
      ) : null}
      {screen.kind === "paired" ? (
        <Today
          key={`${screen.saved.pin}:${screen.saved.space.id}`}
          saved={screen.saved}
          colors={colors}
          onScan={scan}
          onRemoved={() => {
            native.clearPairing();
            setScreen({ kind: "removed" });
          }}
        />
      ) : null}
      {screen.kind === "scan" ? (
        <Scanner
          colors={colors}
          onRead={(qr) => {
            setScreen({ kind: "name", qr, back: screen.back });
          }}
          onCancel={() => {
            setScreen(screen.back);
          }}
        />
      ) : null}
      {screen.kind === "name" ? (
        <Name
          qr={screen.qr}
          colors={colors}
          onPaired={(saved) => {
            native.savePairing(JSON.stringify(saved));
            setScreen({ kind: "paired", saved });
          }}
          onCancel={() => {
            setScreen(screen.back);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
});
