// The Android build's own settings, applied to the project `expo prebuild` generates:
// - Android 10 (API 29) at least, because the link speaks only TLS 1.3;
// - the release build signed with the owner's key when TTASKS_ANDROID_KEYSTORE names it at build
//   time, so a new build installs over the old one and the pairing stays; otherwise with the
//   template's throwaway key, for CI's own tests;
// - the installed-app test in android-test/, built against the release build.
import { withAppBuildGradle, withGradleProperties, type ConfigPlugin } from "expo/config-plugins";

const MIN_SDK = "29";

const APP_GRADLE = `
// From apps/phone/plugins/android.ts.
def ttasksKeystore = System.getenv("TTASKS_ANDROID_KEYSTORE")
if (ttasksKeystore) {
    android.signingConfigs.create("ttasks") {
        storeFile file(ttasksKeystore)
        storeType "pkcs12"
        storePassword System.getenv("TTASKS_ANDROID_KEYSTORE_PASSWORD")
        keyAlias "ttasks"
        keyPassword System.getenv("TTASKS_ANDROID_KEYSTORE_PASSWORD")
    }
    android.buildTypes.release.signingConfig android.signingConfigs.ttasks
}
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
      (item) => !(item.type === "property" && item.key === "android.minSdkVersion"),
    );
    c.modResults.push({ type: "property", key: "android.minSdkVersion", value: MIN_SDK });
    return c;
  });
  return withAppBuildGradle(config, (c) => {
    if (!c.modResults.contents.includes("plugins/android.ts")) c.modResults.contents += APP_GRADLE;
    return c;
  });
};

export default withAndroid;
