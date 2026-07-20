/**
 * GonderPush — official Gönder push SDK for Expo.
 *
 * Uses native device tokens (APNs / FCM) via expo-notifications so Gönder can
 * deliver through the organization's existing APNs and FCM credentials.
 *
 * @example
 * ```ts
 * import { GonderPush, LogLevel } from '@gonderai/expo-push';
 *
 * GonderPush.setLogLevel(LogLevel.Debug);
 * GonderPush.addClickListener((n) => console.log('clicked', n.campaignId));
 * await GonderPush.initialize({ appId: 'YOUR_APP_ID' });
 * await GonderPush.registerForPushNotifications();
 * ```
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

declare const __DEV__: boolean | undefined;

function isDev(): boolean {
  return typeof __DEV__ !== "undefined" ? Boolean(__DEV__) : false;
}

/** Verbosity for SDK logging (least → most). */
export enum LogLevel {
  None = 0,
  Error = 1,
  Warn = 2,
  Info = 3,
  Debug = 4,
  Verbose = 5,
}

export interface GonderPushInitOptions {
  /** Public App ID from Gönder → Platforms → Expo (shared with iOS/Android). */
  appId: string;
  /** API base URL. Defaults to https://gonder.ai */
  baseUrl?: string;
}

/** Normalized notification payload delivered to listeners. */
export interface GonderNotification {
  title: string | null;
  body: string | null;
  campaignId: string | null;
  url: string | null;
  additionalData: Record<string, unknown>;
}

export interface PushSubscriptionState {
  deviceId: string;
  deviceToken: string | null;
  optedIn: boolean;
  externalId: string | null;
}

export type ClickListener = (notification: GonderNotification) => void;
/** Return `false` to suppress the system banner when a push arrives in foreground. */
export type ForegroundLifecycleListener = (
  notification: GonderNotification
) => boolean | void;
export type PermissionObserver = (granted: boolean) => void;
export type SubscriptionObserver = (state: PushSubscriptionState) => void;
export type DebugListener = (message: string) => void;

const STORAGE_DEVICE_ID = "gonder.push.deviceId";
const STORAGE_APP_ID = "gonder.push.appId";
const STORAGE_BASE_URL = "gonder.push.baseUrl";
const STORAGE_EXTERNAL_ID = "gonder.push.externalId";
const STORAGE_DEVICE_TOKEN = "gonder.push.deviceToken";
const STORAGE_OPTED_IN = "gonder.push.optedIn";
const STORAGE_TAGS = "gonder.push.tags";
const STORAGE_CONSENT_REQUIRED = "gonder.push.consentRequired";
const STORAGE_CONSENT_GIVEN = "gonder.push.consentGiven";

const DEFAULT_BASE_URL = "https://gonder.ai";

let appId: string | null = null;
let baseUrl: string = DEFAULT_BASE_URL;
let externalId: string | null = null;
let deviceToken: string | null = null;
let deviceIdCache: string | null = null;
let optedIn = true;
let tags: Record<string, string> = {};
let consentRequired = false;
let consentGiven = false;
let logLevel: LogLevel = isDev() ? LogLevel.Debug : LogLevel.Warn;

let responseSubscription: Notifications.EventSubscription | null = null;
let receivedSubscription: Notifications.EventSubscription | null = null;
let tokenSubscription: Notifications.EventSubscription | null = null;

const clickListeners = new Set<ClickListener>();
const foregroundListeners = new Set<ForegroundLifecycleListener>();
const permissionObservers = new Set<PermissionObserver>();
const subscriptionObservers = new Set<SubscriptionObserver>();
const debugListeners = new Set<DebugListener>();

function shouldLog(level: LogLevel): boolean {
  return logLevel !== LogLevel.None && level <= logLevel;
}

function debugLog(message: string, level: LogLevel = LogLevel.Debug): void {
  if (shouldLog(level)) {
    console.log(`[GonderPush] ${message}`);
  }
  debugListeners.forEach((listener) => {
    try {
      listener(message);
    } catch {
      // ignore listener errors
    }
  });
}

async function persist(key: string, value: string | null): Promise<void> {
  try {
    if (value === null) {
      await AsyncStorage.removeItem(key);
    } else {
      await AsyncStorage.setItem(key, value);
    }
  } catch (error) {
    debugLog(`persist ${key} failed: ${String(error)}`, LogLevel.Warn);
  }
}

async function read(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

function createUuid(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) {
    return c.randomUUID().toLowerCase();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function ensureDeviceId(): Promise<string> {
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

function environment(): "sandbox" | "production" {
  return isDev() ? "sandbox" : "production";
}

function mobilePlatform(): "ios" | "android" {
  return Platform.OS === "android" ? "android" : "ios";
}

function canSendNetwork(): boolean {
  if (!consentRequired) return true;
  return consentGiven;
}

function subscriptionState(): PushSubscriptionState {
  return {
    deviceId: deviceIdCache || "",
    deviceToken,
    optedIn,
    externalId,
  };
}

function notifySubscriptionObservers(): void {
  const state = subscriptionState();
  subscriptionObservers.forEach((observer) => {
    try {
      observer(state);
    } catch {
      // ignore
    }
  });
}

function notifyPermissionObservers(granted: boolean): void {
  permissionObservers.forEach((observer) => {
    try {
      observer(granted);
    } catch {
      // ignore
    }
  });
}

function extractCampaignId(
  data: Record<string, unknown> | undefined
): string | null {
  if (!data) return null;
  const value = data.campaignId ?? data.campaign_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function extractUrl(
  data: Record<string, unknown> | undefined
): string | null {
  if (!data) return null;
  const value = data.url ?? data.launchURL ?? data.launchUrl;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toGonderNotification(
  content: Notifications.NotificationContent
): GonderNotification {
  const data = (content.data ?? {}) as Record<string, unknown>;
  return {
    title: typeof content.title === "string" ? content.title : null,
    body: typeof content.body === "string" ? content.body : null,
    campaignId: extractCampaignId(data),
    url: extractUrl(data),
    additionalData: data,
  };
}

async function post(
  path: string,
  body: Record<string, unknown>
): Promise<void> {
  if (!canSendNetwork()) {
    debugLog(`${path} skipped — consent required but not given`, LogLevel.Info);
    return;
  }
  const url = `${baseUrl}${path}`;
  debugLog(`POST ${path} → ${baseUrl}`, LogLevel.Verbose);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (response.ok) {
      debugLog(`${path} ok (${response.status})`, LogLevel.Debug);
    } else {
      debugLog(
        `${path} HTTP ${response.status}: ${text.slice(0, 120)}`,
        LogLevel.Error
      );
    }
  } catch (error) {
    debugLog(`${path} failed: ${String(error)}`, LogLevel.Error);
  }
}

async function sendRegistration(token: string): Promise<void> {
  if (!appId) {
    debugLog("register skipped — SDK not initialized", LogLevel.Warn);
    return;
  }
  const id = await ensureDeviceId();
  const body: Record<string, unknown> = {
    appId,
    deviceToken: token,
    deviceId: id,
    platform: mobilePlatform(),
    sdk: "expo",
    environment: environment(),
    locale: Intl.DateTimeFormat().resolvedOptions().locale || undefined,
    optedIn,
    tags,
  };
  if (externalId) {
    body.externalId = externalId;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Constants = require("expo-constants") as {
      default?: {
        expoConfig?: {
          ios?: { bundleIdentifier?: string };
          android?: { package?: string };
        };
      };
      expoConfig?: {
        ios?: { bundleIdentifier?: string };
        android?: { package?: string };
      };
    };
    const expoConfig = Constants.default?.expoConfig ?? Constants.expoConfig;
    const bundleId =
      Platform.OS === "ios"
        ? expoConfig?.ios?.bundleIdentifier
        : expoConfig?.android?.package;
    if (bundleId) {
      body.bundleId = bundleId;
    }
  } catch {
    // optional
  }
  await post("/api/mobile-push/register", body);
}

async function sendUnregister(): Promise<void> {
  if (!appId) return;
  const id = await ensureDeviceId();
  const body: Record<string, unknown> = {
    appId,
    deviceId: id,
  };
  if (deviceToken) {
    body.deviceToken = deviceToken;
  }
  await post("/api/mobile-push/unregister", body);
}

async function trackOpened(campaignId: string): Promise<void> {
  if (!appId) return;
  const id = await ensureDeviceId();
  const body: Record<string, unknown> = {
    appId,
    campaignId,
    event: "opened",
    deviceId: id,
  };
  if (deviceToken) {
    body.deviceToken = deviceToken;
  }
  await post("/api/mobile-push/track", body);
}

function fireClickListeners(notification: GonderNotification): void {
  clickListeners.forEach((listener) => {
    try {
      listener(notification);
    } catch {
      // ignore
    }
  });
}

function shouldDisplayInForeground(notification: GonderNotification): boolean {
  if (foregroundListeners.size === 0) return true;
  let display = true;
  foregroundListeners.forEach((listener) => {
    try {
      const result = listener(notification);
      if (result === false) display = false;
    } catch {
      // ignore
    }
  });
  return display;
}

function ensureNotificationHandlers(): void {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const payload = toGonderNotification(notification.request.content);
      const display = shouldDisplayInForeground(payload);
      return {
        shouldShowAlert: display,
        shouldShowBanner: display,
        shouldShowList: display,
        shouldPlaySound: display,
        shouldSetBadge: display,
      };
    },
  });

  if (!responseSubscription) {
    responseSubscription =
      Notifications.addNotificationResponseReceivedListener((response) => {
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
        // Foreground display is controlled via setNotificationHandler above.
        debugLog(
          `notification received (foreground/background delivery)`,
          LogLevel.Verbose
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

async function handleDeviceToken(token: string): Promise<void> {
  const changed = deviceToken !== token;
  deviceToken = token;
  await persist(STORAGE_DEVICE_TOKEN, token);
  debugLog(`Device token received (${token.slice(0, 8)}…)`, LogLevel.Info);
  await sendRegistration(token);
  if (changed) {
    notifySubscriptionObservers();
  }
}

async function initialize(options: GonderPushInitOptions): Promise<void> {
  if (!options.appId || !options.appId.trim()) {
    throw new Error("[GonderPush] appId is required");
  }
  appId = options.appId.trim();
  baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");

  await persist(STORAGE_APP_ID, appId);
  await persist(STORAGE_BASE_URL, baseUrl);

  externalId = await read(STORAGE_EXTERNAL_ID);
  deviceToken = await read(STORAGE_DEVICE_TOKEN);
  const storedOptedIn = await read(STORAGE_OPTED_IN);
  optedIn = storedOptedIn !== "false";
  const storedTags = await read(STORAGE_TAGS);
  if (storedTags) {
    try {
      const parsed = JSON.parse(storedTags) as Record<string, unknown>;
      tags = Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      );
    } catch {
      tags = {};
    }
  }
  consentRequired = (await read(STORAGE_CONSENT_REQUIRED)) === "true";
  consentGiven = (await read(STORAGE_CONSENT_GIVEN)) === "true";

  await ensureDeviceId();
  ensureNotificationHandlers();
  debugLog(`Initialized appId=${appId} baseUrl=${baseUrl}`, LogLevel.Info);

  if (deviceToken) {
    await sendRegistration(deviceToken);
  }
  notifySubscriptionObservers();
}

async function getPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  return current.status === "granted";
}

async function getCanRequestPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.status === "granted") return false;
  // iOS: canAskAgain is false after permanent deny. Android 13+: similar.
  if (typeof current.canAskAgain === "boolean") {
    return current.canAskAgain;
  }
  return current.status === "undetermined" || current.status === "denied";
}

async function requestPermission(
  fallbackToSettings = false
): Promise<boolean> {
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
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Linking } = require("react-native") as typeof import("react-native");
      if (Linking.openSettings) {
        await Linking.openSettings();
      }
    } catch {
      // optional
    }
  }

  return granted;
}

async function registerForPushNotifications(): Promise<void> {
  if (!appId) {
    debugLog(
      "registerForPushNotifications skipped — call initialize first",
      LogLevel.Warn
    );
    return;
  }

  ensureNotificationHandlers();

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("gonder_push", {
      name: "Gönder Push",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#3B82F6",
    });
  }

  const granted = await requestPermission(false);
  if (!granted) {
    debugLog("notification permission not granted", LogLevel.Warn);
    return;
  }

  try {
    const tokenResult = await Notifications.getDevicePushTokenAsync();
    const token =
      typeof tokenResult.data === "string"
        ? tokenResult.data
        : String(tokenResult.data);
    if (!token) {
      debugLog("getDevicePushTokenAsync returned empty token", LogLevel.Error);
      return;
    }
    await handleDeviceToken(token);
  } catch (error) {
    debugLog(`getDevicePushTokenAsync failed: ${String(error)}`, LogLevel.Error);
  }
}

async function setExternalId(id: string): Promise<void> {
  externalId = id;
  await persist(STORAGE_EXTERNAL_ID, id);
  if (deviceToken) {
    await sendRegistration(deviceToken);
  }
  notifySubscriptionObservers();
}

async function removeExternalId(): Promise<void> {
  externalId = null;
  await persist(STORAGE_EXTERNAL_ID, null);
  if (deviceToken) {
    await sendRegistration(deviceToken);
  }
  notifySubscriptionObservers();
}

async function login(id: string): Promise<void> {
  await setExternalId(id);
}

async function logout(): Promise<void> {
  await removeExternalId();
}

function getExternalId(): string | null {
  return externalId;
}

async function unsubscribe(): Promise<void> {
  await sendUnregister();
  optedIn = false;
  await persist(STORAGE_OPTED_IN, "false");
  notifySubscriptionObservers();
}

async function optOut(): Promise<void> {
  optedIn = false;
  await persist(STORAGE_OPTED_IN, "false");
  if (deviceToken) {
    await sendRegistration(deviceToken);
  }
  notifySubscriptionObservers();
}

async function optIn(): Promise<void> {
  optedIn = true;
  await persist(STORAGE_OPTED_IN, "true");
  if (deviceToken) {
    await sendRegistration(deviceToken);
  } else {
    await registerForPushNotifications();
  }
  notifySubscriptionObservers();
}

function isOptedIn(): boolean {
  return optedIn;
}

async function persistTags(): Promise<void> {
  await persist(STORAGE_TAGS, JSON.stringify(tags));
}

async function addTag(key: string, value: string): Promise<void> {
  if (!key) return;
  tags = { ...tags, [key]: String(value) };
  await persistTags();
  if (deviceToken) {
    await sendRegistration(deviceToken);
  }
}

async function addTags(values: Record<string, string>): Promise<void> {
  tags = { ...tags, ...values };
  await persistTags();
  if (deviceToken) {
    await sendRegistration(deviceToken);
  }
}

async function removeTag(key: string): Promise<void> {
  if (!(key in tags)) return;
  const next = { ...tags };
  delete next[key];
  tags = next;
  await persistTags();
  if (deviceToken) {
    await sendRegistration(deviceToken);
  }
}

async function removeTags(keys: string[]): Promise<void> {
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

function getTags(): Record<string, string> {
  return { ...tags };
}

async function setConsentRequired(required: boolean): Promise<void> {
  consentRequired = required;
  await persist(STORAGE_CONSENT_REQUIRED, required ? "true" : "false");
}

async function setConsentGiven(given: boolean): Promise<void> {
  consentGiven = given;
  await persist(STORAGE_CONSENT_GIVEN, given ? "true" : "false");
  if (given && deviceToken) {
    await sendRegistration(deviceToken);
  }
}

function setLogLevel(level: LogLevel): void {
  logLevel = level;
}

function getDeviceId(): string {
  return deviceIdCache || "";
}

function getDeviceToken(): string | null {
  return deviceToken;
}

function addClickListener(listener: ClickListener): () => void {
  clickListeners.add(listener);
  ensureNotificationHandlers();
  return () => {
    clickListeners.delete(listener);
  };
}

function addForegroundLifecycleListener(
  listener: ForegroundLifecycleListener
): () => void {
  foregroundListeners.add(listener);
  ensureNotificationHandlers();
  return () => {
    foregroundListeners.delete(listener);
  };
}

function addPermissionObserver(observer: PermissionObserver): () => void {
  permissionObservers.add(observer);
  return () => {
    permissionObservers.delete(observer);
  };
}

function addSubscriptionObserver(observer: SubscriptionObserver): () => void {
  subscriptionObservers.add(observer);
  try {
    observer(subscriptionState());
  } catch {
    // ignore
  }
  return () => {
    subscriptionObservers.delete(observer);
  };
}

function addDebugListener(listener: DebugListener): () => void {
  debugListeners.add(listener);
  return () => {
    debugListeners.delete(listener);
  };
}

async function clearAllNotifications(): Promise<void> {
  await Notifications.dismissAllNotificationsAsync();
}

export const GonderPush = {
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
  addClickListener,
  addForegroundLifecycleListener,
  addPermissionObserver,
  addSubscriptionObserver,
  addDebugListener,
  clearAllNotifications,
};

export default GonderPush;
