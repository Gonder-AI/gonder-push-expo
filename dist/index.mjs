var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/index.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
function isDev() {
  return typeof __DEV__ !== "undefined" ? Boolean(__DEV__) : false;
}
var LogLevel = /* @__PURE__ */ ((LogLevel2) => {
  LogLevel2[LogLevel2["None"] = 0] = "None";
  LogLevel2[LogLevel2["Error"] = 1] = "Error";
  LogLevel2[LogLevel2["Warn"] = 2] = "Warn";
  LogLevel2[LogLevel2["Info"] = 3] = "Info";
  LogLevel2[LogLevel2["Debug"] = 4] = "Debug";
  LogLevel2[LogLevel2["Verbose"] = 5] = "Verbose";
  return LogLevel2;
})(LogLevel || {});
var STORAGE_DEVICE_ID = "gonder.push.deviceId";
var STORAGE_APP_ID = "gonder.push.appId";
var STORAGE_BASE_URL = "gonder.push.baseUrl";
var STORAGE_EXTERNAL_ID = "gonder.push.externalId";
var STORAGE_DEVICE_TOKEN = "gonder.push.deviceToken";
var STORAGE_SUBSCRIPTION_ID = "gonder.push.subscriptionId";
var STORAGE_OPTED_IN = "gonder.push.optedIn";
var STORAGE_TAGS = "gonder.push.tags";
var STORAGE_CONSENT_REQUIRED = "gonder.push.consentRequired";
var STORAGE_CONSENT_GIVEN = "gonder.push.consentGiven";
var DEFAULT_BASE_URL = "https://gonder.ai";
var appId = null;
var baseUrl = DEFAULT_BASE_URL;
var externalId = null;
var deviceToken = null;
var deviceIdCache = null;
var subscriptionId = null;
var optedIn = true;
var tags = {};
var consentRequired = false;
var consentGiven = false;
var logLevel = isDev() ? 4 /* Debug */ : 2 /* Warn */;
var responseSubscription = null;
var receivedSubscription = null;
var tokenSubscription = null;
var clickListeners = /* @__PURE__ */ new Set();
var foregroundListeners = /* @__PURE__ */ new Set();
var permissionObservers = /* @__PURE__ */ new Set();
var subscriptionObservers = /* @__PURE__ */ new Set();
var debugListeners = /* @__PURE__ */ new Set();
function shouldLog(level) {
  return logLevel !== 0 /* None */ && level <= logLevel;
}
function debugLog(message, level = 4 /* Debug */) {
  if (shouldLog(level)) {
    console.log(`[GonderPush] ${message}`);
  }
  debugListeners.forEach((listener) => {
    try {
      listener(message);
    } catch {
    }
  });
}
async function persist(key, value) {
  try {
    if (value === null) {
      await AsyncStorage.removeItem(key);
    } else {
      await AsyncStorage.setItem(key, value);
    }
  } catch (error) {
    debugLog(`persist ${key} failed: ${String(error)}`, 2 /* Warn */);
  }
}
async function read(key) {
  try {
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}
function createUuid() {
  const c = globalThis.crypto;
  if (c?.randomUUID) {
    return c.randomUUID().toLowerCase();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = Math.random() * 16 | 0;
    const v = ch === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}
async function ensureDeviceId() {
  if (deviceIdCache) return deviceIdCache;
  const existing = await read(STORAGE_DEVICE_ID);
  if (existing) {
    deviceIdCache = existing;
    return existing;
  }
  const created = createUuid();
  deviceIdCache = created;
  await persist(STORAGE_DEVICE_ID, created);
  return created;
}
function environment() {
  return isDev() ? "sandbox" : "production";
}
function mobilePlatform() {
  return Platform.OS === "android" ? "android" : "ios";
}
function canSendNetwork() {
  if (!consentRequired) return true;
  return consentGiven;
}
function subscriptionState() {
  return {
    deviceId: deviceIdCache || "",
    deviceToken,
    optedIn,
    externalId,
    subscriptionId
  };
}
function notifySubscriptionObservers() {
  const state = subscriptionState();
  subscriptionObservers.forEach((observer) => {
    try {
      observer(state);
    } catch {
    }
  });
}
function notifyPermissionObservers(granted) {
  permissionObservers.forEach((observer) => {
    try {
      observer(granted);
    } catch {
    }
  });
}
function extractCampaignId(data) {
  if (!data) return null;
  const value = data.campaignId ?? data.campaign_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}
function extractUrl(data) {
  if (!data) return null;
  const value = data.url ?? data.launchURL ?? data.launchUrl;
  return typeof value === "string" && value.length > 0 ? value : null;
}
function toGonderNotification(content) {
  const data = content.data ?? {};
  return {
    title: typeof content.title === "string" ? content.title : null,
    body: typeof content.body === "string" ? content.body : null,
    campaignId: extractCampaignId(data),
    url: extractUrl(data),
    additionalData: data
  };
}
async function post(path, body) {
  if (!canSendNetwork()) {
    debugLog(`${path} skipped \u2014 consent required but not given`, 3 /* Info */);
    return null;
  }
  const url = `${baseUrl}${path}`;
  debugLog(`POST ${path} \u2192 ${baseUrl}`, 5 /* Verbose */);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
      debugLog(
        `${path} HTTP ${response.status}: ${text.slice(0, 120)}`,
        1 /* Error */
      );
      return null;
    }
    debugLog(`${path} ok (${response.status})`, 4 /* Debug */);
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch (error) {
    debugLog(`${path} failed: ${String(error)}`, 1 /* Error */);
    return null;
  }
}
function collectDeviceContext() {
  const context = {};
  try {
    const required = __require("expo-device");
    const Device = required.default ?? required;
    const model = Device.modelId || Device.modelName;
    if (model) context.deviceModel = model;
    if (Device.manufacturer) context.deviceManufacturer = Device.manufacturer;
    if (Device.osName) context.osName = Device.osName;
    if (Device.osVersion) context.osVersion = Device.osVersion;
    if (typeof Device.platformApiLevel === "number") {
      context.osApiLevel = Device.platformApiLevel;
    }
  } catch {
  }
  const runtime = Platform;
  const constants = runtime.constants;
  if (Platform.OS === "android") {
    context.deviceModel = context.deviceModel || constants?.Model;
    context.deviceManufacturer = context.deviceManufacturer || constants?.Manufacturer || constants?.Brand;
    context.osVersion = context.osVersion || constants?.Release;
    if (context.osApiLevel === void 0 && typeof constants?.Version === "number") {
      context.osApiLevel = constants.Version;
    }
    context.osName = context.osName || "Android";
  } else {
    context.deviceManufacturer = context.deviceManufacturer || "Apple";
    context.osVersion = context.osVersion || constants?.osVersion || (runtime.Version !== void 0 ? String(runtime.Version) : void 0);
    context.osName = context.osName || constants?.systemName || "iOS";
  }
  return context;
}
function deviceTimezone() {
  let timezone;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || void 0;
  } catch {
    timezone = void 0;
  }
  return { timezone, offsetMinutes: -(/* @__PURE__ */ new Date()).getTimezoneOffset() };
}
function deviceLanguage() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || void 0;
  } catch {
    return void 0;
  }
}
async function sendRegistration(token) {
  if (!appId) {
    debugLog("register skipped \u2014 SDK not initialized", 2 /* Warn */);
    return;
  }
  const id = await ensureDeviceId();
  const language = deviceLanguage();
  const { timezone, offsetMinutes } = deviceTimezone();
  const body = {
    appId,
    deviceToken: token,
    deviceId: id,
    platform: mobilePlatform(),
    sdk: "expo",
    environment: environment(),
    locale: language,
    language,
    timezone,
    timezoneOffsetMinutes: offsetMinutes,
    optedIn,
    tags,
    ...collectDeviceContext()
  };
  if (externalId) {
    body.externalId = externalId;
  }
  try {
    const Constants = __require("expo-constants");
    const expoConfig = Constants.default?.expoConfig ?? Constants.expoConfig;
    const bundleId = Platform.OS === "ios" ? expoConfig?.ios?.bundleIdentifier : expoConfig?.android?.package;
    if (bundleId) {
      body.bundleId = bundleId;
    }
  } catch {
  }
  const response = await post("/api/mobile-push/register", body);
  await handleRegistrationResponse(response);
}
async function handleRegistrationResponse(response) {
  const data = response?.data;
  const identifier = data?.subscriptionId ?? data?.subscriberId;
  if (typeof identifier !== "string" || identifier.length === 0) return;
  if (identifier === subscriptionId) return;
  subscriptionId = identifier;
  await persist(STORAGE_SUBSCRIPTION_ID, identifier);
  debugLog(`subscriptionId=${identifier}`, 3 /* Info */);
  notifySubscriptionObservers();
}
async function sendUnregister() {
  if (!appId) return;
  const id = await ensureDeviceId();
  const body = {
    appId,
    deviceId: id
  };
  if (deviceToken) {
    body.deviceToken = deviceToken;
  }
  await post("/api/mobile-push/unregister", body);
}
async function trackOpened(campaignId) {
  if (!appId) return;
  const id = await ensureDeviceId();
  const body = {
    appId,
    campaignId,
    event: "opened",
    deviceId: id
  };
  if (deviceToken) {
    body.deviceToken = deviceToken;
  }
  await post("/api/mobile-push/track", body);
}
function fireClickListeners(notification) {
  clickListeners.forEach((listener) => {
    try {
      listener(notification);
    } catch {
    }
  });
}
function shouldDisplayInForeground(notification) {
  if (foregroundListeners.size === 0) return true;
  let display = true;
  foregroundListeners.forEach((listener) => {
    try {
      const result = listener(notification);
      if (result === false) display = false;
    } catch {
    }
  });
  return display;
}
function ensureNotificationHandlers() {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const payload = toGonderNotification(notification.request.content);
      const display = shouldDisplayInForeground(payload);
      return {
        shouldShowAlert: display,
        shouldShowBanner: display,
        shouldShowList: display,
        shouldPlaySound: display,
        shouldSetBadge: display
      };
    }
  });
  if (!responseSubscription) {
    responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const payload = toGonderNotification(
        response.notification.request.content
      );
      fireClickListeners(payload);
      if (payload.campaignId) {
        void trackOpened(payload.campaignId);
      }
    });
  }
  if (!receivedSubscription) {
    receivedSubscription = Notifications.addNotificationReceivedListener(
      (notification) => {
        debugLog(
          `notification received (foreground/background delivery)`,
          5 /* Verbose */
        );
        void notification;
      }
    );
  }
  if (!tokenSubscription) {
    tokenSubscription = Notifications.addPushTokenListener((token) => {
      const value = token.data;
      if (typeof value === "string" && value.length > 0) {
        void handleDeviceToken(value);
      }
    });
  }
}
async function handleDeviceToken(token) {
  const changed = deviceToken !== token;
  deviceToken = token;
  await persist(STORAGE_DEVICE_TOKEN, token);
  debugLog(`Device token received (${token.slice(0, 8)}\u2026)`, 3 /* Info */);
  await sendRegistration(token);
  if (changed) {
    notifySubscriptionObservers();
  }
}
async function initialize(options) {
  if (!options.appId || !options.appId.trim()) {
    throw new Error("[GonderPush] appId is required");
  }
  appId = options.appId.trim();
  baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  await persist(STORAGE_APP_ID, appId);
  await persist(STORAGE_BASE_URL, baseUrl);
  externalId = await read(STORAGE_EXTERNAL_ID);
  deviceToken = await read(STORAGE_DEVICE_TOKEN);
  subscriptionId = await read(STORAGE_SUBSCRIPTION_ID);
  const storedOptedIn = await read(STORAGE_OPTED_IN);
  optedIn = storedOptedIn !== "false";
  const storedTags = await read(STORAGE_TAGS);
  if (storedTags) {
    try {
      const parsed = JSON.parse(storedTags);
      tags = Object.fromEntries(
        Object.entries(parsed).filter(
          (entry) => typeof entry[1] === "string"
        )
      );
    } catch {
      tags = {};
    }
  }
  consentRequired = await read(STORAGE_CONSENT_REQUIRED) === "true";
  consentGiven = await read(STORAGE_CONSENT_GIVEN) === "true";
  await ensureDeviceId();
  ensureNotificationHandlers();
  debugLog(`Initialized appId=${appId} baseUrl=${baseUrl}`, 3 /* Info */);
  if (deviceToken) {
    await sendRegistration(deviceToken);
  }
  notifySubscriptionObservers();
}
async function getPermission() {
  const current = await Notifications.getPermissionsAsync();
  return current.status === "granted";
}
async function getCanRequestPermission() {
  const current = await Notifications.getPermissionsAsync();
  if (current.status === "granted") return false;
  if (typeof current.canAskAgain === "boolean") {
    return current.canAskAgain;
  }
  return current.status === "undetermined" || current.status === "denied";
}
async function requestPermission(fallbackToSettings = false) {
  ensureNotificationHandlers();
  const current = await Notifications.getPermissionsAsync();
  if (current.status === "granted") {
    notifyPermissionObservers(true);
    return true;
  }
  const requested = await Notifications.requestPermissionsAsync();
  const granted = requested.status === "granted";
  notifyPermissionObservers(granted);
  if (!granted && fallbackToSettings) {
    try {
      const { Linking } = __require("react-native");
      if (Linking.openSettings) {
        await Linking.openSettings();
      }
    } catch {
    }
  }
  return granted;
}
async function registerForPushNotifications() {
  if (!appId) {
    debugLog(
      "registerForPushNotifications skipped \u2014 call initialize first",
      2 /* Warn */
    );
    return;
  }
  ensureNotificationHandlers();
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("gonder_push", {
      name: "G\xF6nder Push",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#3B82F6"
    });
  }
  const granted = await requestPermission(false);
  if (!granted) {
    debugLog("notification permission not granted", 2 /* Warn */);
    return;
  }
  try {
    const tokenResult = await Notifications.getDevicePushTokenAsync();
    const token = typeof tokenResult.data === "string" ? tokenResult.data : String(tokenResult.data);
    if (!token) {
      debugLog("getDevicePushTokenAsync returned empty token", 1 /* Error */);
      return;
    }
    await handleDeviceToken(token);
  } catch (error) {
    debugLog(`getDevicePushTokenAsync failed: ${String(error)}`, 1 /* Error */);
  }
}
async function setExternalId(id) {
  externalId = id;
  await persist(STORAGE_EXTERNAL_ID, id);
  if (deviceToken) {
    await sendRegistration(deviceToken);
  }
  notifySubscriptionObservers();
}
async function removeExternalId() {
  externalId = null;
  await persist(STORAGE_EXTERNAL_ID, null);
  if (deviceToken) {
    await sendRegistration(deviceToken);
  }
  notifySubscriptionObservers();
}
async function login(id) {
  await setExternalId(id);
}
async function logout() {
  await removeExternalId();
}
function getExternalId() {
  return externalId;
}
async function unsubscribe() {
  await sendUnregister();
  optedIn = false;
  await persist(STORAGE_OPTED_IN, "false");
  notifySubscriptionObservers();
}
async function optOut() {
  optedIn = false;
  await persist(STORAGE_OPTED_IN, "false");
  if (deviceToken) {
    await sendRegistration(deviceToken);
  }
  notifySubscriptionObservers();
}
async function optIn() {
  optedIn = true;
  await persist(STORAGE_OPTED_IN, "true");
  if (deviceToken) {
    await sendRegistration(deviceToken);
  } else {
    await registerForPushNotifications();
  }
  notifySubscriptionObservers();
}
function isOptedIn() {
  return optedIn;
}
async function persistTags() {
  await persist(STORAGE_TAGS, JSON.stringify(tags));
}
async function addTag(key, value) {
  if (!key) return;
  tags = { ...tags, [key]: String(value) };
  await persistTags();
  if (deviceToken) {
    await sendRegistration(deviceToken);
  }
}
async function addTags(values) {
  tags = { ...tags, ...values };
  await persistTags();
  if (deviceToken) {
    await sendRegistration(deviceToken);
  }
}
async function removeTag(key) {
  if (!(key in tags)) return;
  const next = { ...tags };
  delete next[key];
  tags = next;
  await persistTags();
  if (deviceToken) {
    await sendRegistration(deviceToken);
  }
}
async function removeTags(keys) {
  const next = { ...tags };
  for (const key of keys) {
    delete next[key];
  }
  tags = next;
  await persistTags();
  if (deviceToken) {
    await sendRegistration(deviceToken);
  }
}
function getTags() {
  return { ...tags };
}
async function setConsentRequired(required) {
  consentRequired = required;
  await persist(STORAGE_CONSENT_REQUIRED, required ? "true" : "false");
}
async function setConsentGiven(given) {
  consentGiven = given;
  await persist(STORAGE_CONSENT_GIVEN, given ? "true" : "false");
  if (given && deviceToken) {
    await sendRegistration(deviceToken);
  }
}
function setLogLevel(level) {
  logLevel = level;
}
function getDeviceId() {
  return deviceIdCache || "";
}
function getDeviceToken() {
  return deviceToken;
}
function getSubscriptionId() {
  return subscriptionId;
}
function addClickListener(listener) {
  clickListeners.add(listener);
  ensureNotificationHandlers();
  return () => {
    clickListeners.delete(listener);
  };
}
function addForegroundLifecycleListener(listener) {
  foregroundListeners.add(listener);
  ensureNotificationHandlers();
  return () => {
    foregroundListeners.delete(listener);
  };
}
function addPermissionObserver(observer) {
  permissionObservers.add(observer);
  return () => {
    permissionObservers.delete(observer);
  };
}
function addSubscriptionObserver(observer) {
  subscriptionObservers.add(observer);
  try {
    observer(subscriptionState());
  } catch {
  }
  return () => {
    subscriptionObservers.delete(observer);
  };
}
function addDebugListener(listener) {
  debugListeners.add(listener);
  return () => {
    debugListeners.delete(listener);
  };
}
async function clearAllNotifications() {
  await Notifications.dismissAllNotificationsAsync();
}
var GonderPush = {
  initialize,
  registerForPushNotifications,
  requestPermission,
  getPermission,
  getCanRequestPermission,
  setExternalId,
  removeExternalId,
  login,
  logout,
  getExternalId,
  unsubscribe,
  optIn,
  optOut,
  isOptedIn,
  addTag,
  addTags,
  removeTag,
  removeTags,
  getTags,
  setConsentRequired,
  setConsentGiven,
  setLogLevel,
  getDeviceId,
  getDeviceToken,
  getSubscriptionId,
  addClickListener,
  addForegroundLifecycleListener,
  addPermissionObserver,
  addSubscriptionObserver,
  addDebugListener,
  clearAllNotifications
};
var index_default = GonderPush;
export {
  GonderPush,
  LogLevel,
  index_default as default
};
