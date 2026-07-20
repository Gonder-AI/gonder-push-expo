/**
 * Expo config plugin for @gonderai/expo-push.
 *
 * Ensures iOS push entitlements / background modes and Android POST_NOTIFICATIONS
 * permission are present after `npx expo prebuild`. Compose with
 * `expo-notifications` in app.json for full coverage.
 *
 * @see https://docs.expo.dev/config-plugins/plugins/
 */

// Prefer @expo/config-plugins (declared dependency) so resolution works when
// this package is linked via `file:` (realpath lives outside the app tree).
// Falls back to expo/config-plugins for apps that only have expo installed.
function loadConfigPlugins() {
  try {
    return require("@expo/config-plugins");
  } catch {
    return require("expo/config-plugins");
  }
}

const {
  withEntitlementsPlist,
  withInfoPlist,
  AndroidConfig,
} = loadConfigPlugins();

/**
 * @param {import('@expo/config-plugins').ExpoConfig} config
 * @param {{ mode?: 'development' | 'production' }} [props]
 */
function withGonderPush(config, props = {}) {
  const mode = props.mode === "production" ? "production" : "development";

  config = withEntitlementsPlist(config, (cfg) => {
    cfg.modResults["aps-environment"] =
      cfg.modResults["aps-environment"] || mode;
    return cfg;
  });

  config = withInfoPlist(config, (cfg) => {
    const modes = new Set(cfg.modResults.UIBackgroundModes || []);
    modes.add("remote-notification");
    cfg.modResults.UIBackgroundModes = Array.from(modes);
    return cfg;
  });

  // withPermissions merges into config.android.permissions and applies via manifest.
  // Do not assign ensurePermissions()'s return value to modResults — it returns
  // `{ [permission]: boolean }`, not the AndroidManifest (it mutates in place).
  config = AndroidConfig.Permissions.withPermissions(config, [
    "android.permission.POST_NOTIFICATIONS",
  ]);

  return config;
}

module.exports = withGonderPush;
