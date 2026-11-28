// Pairing: the scanner, then the one question, the phone's name.
import { useEffect, useRef, useState } from "react";
import { AppState, Linking, Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { pairWith, type Saved } from "@ttasks/client/link";
import { parsePairing, type Pairing } from "@ttasks/contracts/link";
import { connectSocket, native } from "./link/socket.ts";
import { Button, shared, type Colors } from "./ui.tsx";
import { WORDS } from "./words.ts";

/**
 * The camera, reading QR codes only, asked for when the scan opens. The first pairing code read is
 * taken and the camera closes; anything else is said and the camera stays.
 */
export function Scanner(props: {
  colors: Colors;
  onRead: (qr: Pairing) => void;
  onCancel: () => void;
}) {
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
      setNote(WORDS.notACode);
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
    <View style={shared.fill}>
      {permission?.granted === true ? (
        <CameraView
          style={shared.fill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            read(data);
          }}
        />
      ) : (
        <View style={shared.middle}>
          <Text style={[shared.body, { color: colors.text }]}>{WORDS.camera}</Text>
          {permission !== null && !permission.canAskAgain ? (
            <Button
              label={WORDS.openSettings}
              onPress={() => {
                void Linking.openSettings();
              }}
              colors={colors}
              primary
            />
          ) : (
            <Button
              label={WORDS.allowCamera}
              onPress={() => {
                void request();
              }}
              colors={colors}
              primary
            />
          )}
        </View>
      )}
      <View style={shared.bottom}>
        {note === undefined ? null : (
          <Text style={[shared.body, { color: colors.text }]}>{note}</Text>
        )}
        <Button label={WORDS.cancel} onPress={onCancel} colors={colors} />
      </View>
    </View>
  );
}

/** The one question of a pairing: the phone's name, filled with what Android calls it. */
export function Name(props: {
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
      // The session opens its own link from the saved pairing.
      paired.socket.close();
      onPaired(paired.saved);
      return;
    }
    setProblem(
      paired.kind === "removed"
        ? WORDS.codeGone
        : paired.pin
          ? WORDS.codeOtherKey
          : WORDS.couldNotPair,
    );
  };

  return (
    <View style={shared.middle}>
      <Text style={[shared.title, { color: colors.text }]}>{WORDS.pairWith(qr.space.name)}</Text>
      <Text style={[shared.small, { color: colors.muted }]}>{WORDS.phoneName}</Text>
      <TextInput
        style={[shared.input, { color: colors.text, borderColor: colors.muted }]}
        value={name}
        onChangeText={setName}
        maxLength={80}
        editable={!busy}
        accessibilityLabel={WORDS.phoneName}
      />
      {problem === undefined ? null : (
        <Text style={[shared.body, { color: colors.text }]}>{problem}</Text>
      )}
      <Button
        label={busy ? WORDS.pairing : WORDS.pair}
        onPress={() => {
          void pair();
        }}
        colors={colors}
        primary
        disabled={busy}
      />
      <Button label={WORDS.cancel} onPress={onCancel} colors={colors} disabled={busy} />
    </View>
  );
}
