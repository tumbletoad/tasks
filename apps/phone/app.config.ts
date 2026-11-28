// The app's Expo configuration. Its names come from @ttasks/brand; the Android build's own
// settings are in plugins/android.ts.
import type { ExpoConfig } from "expo/config";
import { ANDROID_APP_ID, PRODUCT_ID, PRODUCT_NAME } from "@ttasks/brand";

// Android installs an update only over a lower versionCode. Minutes since 2026 never go down from
// one build to the next, wherever the build runs.
const versionCode = Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 60_000);

const config: ExpoConfig = {
  name: PRODUCT_NAME,
  slug: PRODUCT_ID,
  version: "0.0.0",
  orientation: "portrait",
  platforms: ["android"],
  android: {
    package: ANDROID_APP_ID,
    versionCode,
    // The pairing must not come back on another phone, or on this one restored, without its key,
    // which the Keystore never puts in a backup.
    allowBackup: false,
  },
  // The camera only scans the pairing code: no microphone.
  plugins: ["./plugins/android.ts", ["expo-camera", { recordAudioAndroid: false }]],
};

export default config;
