// The Android build's own settings, applied to the project `expo prebuild` generates:
// - Android 10 (API 29) at least, because the link speaks only TLS 1.3;
// - no R8 in the release build: the installed-app test runs inside it and calls its classes, which
//   R8 renames and drops, and a sideloaded app gains little from a smaller APK;
// - the installed-app test in android-test/, built against the release build.
import { withAppBuildGradle, withGradleProperties, type ConfigPlugin } from "expo/config-plugins";

/** gradle.properties of the generated project, set whatever the template had. */
const PROPERTIES: Record<string, string> = {
  "android.minSdkVersion": "29",
  "android.enableMinifyInReleaseBuilds": "false",
};

const APP_GRADLE = `
// From apps/phone/plugins/android.ts.
android {
    testBuildType "release"
    defaultConfig {
        testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"
    }
    sourceSets {
        androidTest.java.srcDirs += "\${rootDir}/../android-test/java"
    }
}
dependencies {
    androidTestImplementation "androidx.test:runner:1.6.2"
    androidTestImplementation "androidx.test.ext:junit:1.2.1"
}
`;

const withAndroid: ConfigPlugin = (config) => {
  config = withGradleProperties(config, (c) => {
    c.modResults = c.modResults.filter(
      (item) => !(item.type === "property" && item.key in PROPERTIES),
    );
    for (const [key, value] of Object.entries(PROPERTIES)) {
      c.modResults.push({ type: "property", key, value });
    }
    return c;
  });
  return withAppBuildGradle(config, (c) => {
    if (!c.modResults.contents.includes("plugins/android.ts")) c.modResults.contents += APP_GRADLE;
    return c;
  });
};

export default withAndroid;
