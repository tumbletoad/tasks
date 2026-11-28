// The app's one screen in this first step. Not paired: scan the code from Settings > Phones, name
// the phone, pair. Paired: the space and whether the link is up, with Try now while it is not, and
// Scan a new code (a new pairing replaces the saved one only once it succeeded). A cold start shows
// the saved space at once, with Connecting until a fresh hello. Only the computer's `removed`
// forgets the pairing; a lost connection keeps it.
import { useEffect, useRef, useState } from "react";
import {
  AppState,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { PRODUCT_NAME } from "@ttasks/brand";
import { linkOwner, pairWith, readSaved, type LinkState, type Saved } from "@ttasks/client/link";
import { parsePairing, type Pairing } from "@ttasks/contracts/link";
import { connectSocket, native } from "./link/socket.ts";

type Screen =
  | { readonly kind: "unpaired" }
  | { readonly kind: "removed" }
  | { readonly kind: "paired"; readonly saved: Saved }
  /** `back`: where Cancel returns. */
  | { readonly kind: "scan"; readonly back: Screen }
  | { readonly kind: "name"; readonly qr: Pairing; readonly back: Screen };

const keep = (saved: Saved) => {
  native.savePairing(JSON.stringify(saved));
};

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
        <View style={styles.middle}>
          <Text style={[styles.title, { color: colors.text }]}>{PRODUCT_NAME}</Text>
          <Text style={[styles.body, { color: colors.text }]}>
            {screen.kind === "removed"
              ? "This phone was removed on the computer."
              : "Not paired with a computer."}
          </Text>
          <Text style={[styles.body, { color: colors.muted }]}>
            Open Settings &gt; Phones on your computer and scan its code.
          </Text>
          <Button label="Scan the code" onPress={scan} colors={colors} primary />
        </View>
      ) : null}
      {screen.kind === "paired" ? (
        <Paired
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
            keep(saved);
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

const SAYS: Record<LinkState["kind"], string> = {
  connecting: "Connecting…",
  connected: "Connected",
  offline: "Can't reach the computer.",
  removed: "This phone was removed on the computer.",
};

/**
 * The paired space and its link. One owner holds the link: it opens at launch and when the app
 * comes back to the front, again on another network, retries while it is down, and holds nothing
 * while the app is in the background.
 */
function Paired(props: {
  saved: Saved;
  colors: Colors;
  onScan: () => void;
  onRemoved: () => void;
}) {
  const { saved, colors, onScan, onRemoved } = props;
  const [state, setState] = useState<LinkState>({ kind: "connecting" });
  const [space, setSpace] = useState(saved.space.name);
  const owner = useRef<ReturnType<typeof linkOwner> | undefined>(undefined);
  const removed = useRef(onRemoved);
  removed.current = onRemoved;

  useEffect(() => {
    const link = linkOwner(connectSocket, saved, (next, pairing) => {
      setState(next);
      if (next.kind === "connected") {
        setSpace(pairing.space.name);
        keep(pairing);
      }
      if (next.kind === "removed") removed.current();
    });
    owner.current = link;
    // A pairing that ended after the app went to the background waits for the front.
    if (AppState.currentState !== "background") link.start();
    const app = AppState.addEventListener("change", (now) => {
      if (now === "active") link.start();
      else if (now === "background") link.stop();
    });
    const network = native.addListener("network", () => {
      link.now();
    });
    return () => {
      link.stop();
      app.remove();
      network.remove();
    };
  }, [saved]);

  return (
    <View style={styles.middle}>
      <Text style={[styles.title, { color: colors.text }]}>
        {space === "" ? PRODUCT_NAME : space}
      </Text>
      <Text style={[styles.body, { color: colors.text }]}>{SAYS[state.kind]}</Text>
      {state.kind === "offline" && state.pin ? (
        <Text style={[styles.body, { color: colors.muted }]}>
          The computer at its address has another key. Scan a new code if it was set up again.
        </Text>
      ) : null}
      {state.kind === "offline" ? (
        <Button label="Try now" onPress={() => owner.current?.now()} colors={colors} primary />
      ) : null}
      <Button label="Scan a new code" onPress={onScan} colors={colors} />
    </View>
  );
}

/**
 * The camera, reading QR codes only, asked for when the scan opens. The first pairing code read is
 * taken and the camera closes; anything else is said and the camera stays.
 */
function Scanner(props: { colors: Colors; onRead: (qr: Pairing) => void; onCancel: () => void }) {
  const { colors, onRead, onCancel } = props;
  const [permission, request, reread] = useCameraPermissions();
  const [note, setNote] = useState<string | undefined>(undefined);
  const taken = useRef(false);
  const handlers = useRef({ onRead });
  handlers.current = { onRead };

  const read = useRef((text: string) => {
    if (taken.current) return;
    const qr = parsePairing(text);
    if (qr === undefined) {
      setNote("This is not a TTasks pairing code.");
      return;
    }
    taken.current = true;
    handlers.current.onRead(qr);
  }).current;

  // Asked once, as the scanner opens; after that only the button asks. Back from Android's
  // settings, the answer there is read again.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || permission === null) return;
    asked.current = true;
    if (!permission.granted && permission.canAskAgain) void request();
  }, [permission, request]);
  useEffect(() => {
    const app = AppState.addEventListener("change", (now) => {
      if (now === "active") void reread();
    });
    return () => {
      app.remove();
    };
  }, [reread]);
  useEffect(() => {
    const scanned = native.addListener("scan", ({ text }) => {
      read(text);
    });
    return () => {
      scanned.remove();
    };
  }, [read]);

  return (
    <View style={styles.fill}>
      {permission?.granted === true ? (
        <CameraView
          style={styles.fill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            read(data);
          }}
        />
      ) : (
        <View style={styles.middle}>
          <Text style={[styles.body, { color: colors.text }]}>
            {PRODUCT_NAME} needs the camera to scan the code.
          </Text>
          {permission !== null && !permission.canAskAgain ? (
            <Button
              label="Open Settings"
              onPress={() => {
                void Linking.openSettings();
              }}
              colors={colors}
              primary
            />
          ) : (
            <Button
              label="Allow the camera"
              onPress={() => {
                void request();
              }}
              colors={colors}
              primary
            />
          )}
        </View>
      )}
      <View style={styles.bottom}>
        {note === undefined ? null : (
          <Text style={[styles.body, { color: colors.text }]}>{note}</Text>
        )}
        <Button label="Cancel" onPress={onCancel} colors={colors} />
      </View>
    </View>
  );
}

/** The one question of a pairing: the phone's name, filled with what Android calls it. */
function Name(props: {
  qr: Pairing;
  colors: Colors;
  onPaired: (saved: Saved) => void;
  onCancel: () => void;
}) {
  const { qr, colors, onPaired, onCancel } = props;
  const [name, setName] = useState(() => native.deviceName());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const pair = async () => {
    setBusy(true);
    setProblem(undefined);
    const paired = await pairWith(
      connectSocket,
      qr,
      name.trim() === "" ? native.deviceName() : name.trim(),
    );
    setBusy(false);
    if (paired.kind === "served") {
      // The owner opens its own link from the saved pairing.
      paired.socket.close();
      onPaired(paired.saved);
      return;
    }
    setProblem(
      paired.kind === "removed"
        ? "This code no longer works. Show a new one in Settings > Phones and scan it."
        : paired.pin
          ? "The computer at this code's address has another key. Scan a new code."
          : // An expired or used code is refused without a word, so it reads like no answer.
            "Couldn't pair. Check the network or scan a fresh code from Settings > Phones.",
    );
  };

  return (
    <View style={styles.middle}>
      <Text style={[styles.title, { color: colors.text }]}>
        {qr.space.name === "" ? "Pair with this space" : `Pair with ${qr.space.name}`}
      </Text>
      <Text style={[styles.label, { color: colors.muted }]}>This phone's name</Text>
      <TextInput
        style={[styles.input, { color: colors.text, borderColor: colors.muted }]}
        value={name}
        onChangeText={setName}
        maxLength={80}
        editable={!busy}
        accessibilityLabel="This phone's name"
      />
      {problem === undefined ? null : (
        <Text style={[styles.body, { color: colors.text }]}>{problem}</Text>
      )}
      <Button
        label={busy ? "Pairing…" : "Pair"}
        onPress={() => {
          void pair();
        }}
        colors={colors}
        primary
        disabled={busy}
      />
      <Button label="Cancel" onPress={onCancel} colors={colors} disabled={busy} />
    </View>
  );
}

function Button(props: {
  label: string;
  onPress: () => void;
  colors: Colors;
  primary?: boolean;
  disabled?: boolean;
}) {
  const { label, onPress, colors, primary = false, disabled = false } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { borderColor: colors.accent },
        primary ? { backgroundColor: colors.accent } : null,
        pressed || disabled ? styles.pressed : null,
      ]}
    >
      <Text style={[styles.buttonText, { color: primary ? colors.onAccent : colors.accent }]}>
        {label}
      </Text>
    </Pressable>
  );
}

interface Colors {
  readonly background: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
  readonly onAccent: string;
}

function useColors(): Colors {
  return useColorScheme() === "dark"
    ? {
        background: "#16181c",
        text: "#eceef1",
        muted: "#9aa1ab",
        accent: "#8ab4ff",
        onAccent: "#0d1a33",
      }
    : {
        background: "#ffffff",
        text: "#16181c",
        muted: "#5b626d",
        accent: "#2457c5",
        onAccent: "#ffffff",
      };
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  fill: { flex: 1 },
  middle: { flex: 1, justifyContent: "center", padding: 24, gap: 12 },
  bottom: { padding: 24, gap: 12 },
  title: { fontSize: 28, fontWeight: "600" },
  body: { fontSize: 16, lineHeight: 22 },
  label: { fontSize: 14 },
  input: {
    fontSize: 18,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  button: { borderWidth: 1, borderRadius: 8, paddingVertical: 12, alignItems: "center" },
  buttonText: { fontSize: 16, fontWeight: "600" },
  pressed: { opacity: 0.6 },
});
