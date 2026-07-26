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
  /** Gönder subscription id for this installation, assigned on first register. */
  subscriptionId: string | null;
  /**
   * Gönder user id this installation belongs to. Null while anonymous; set
   * once `login()` associates the device with an external id.
   */
  userId: string | null;
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
const STORAGE_SUBSCRIPTION_ID = "gonder.push.subscriptionId";
const STORAGE_USER_ID = "gonder.push.userId";
const STORAGE_OPTED_IN = "gonder.push.optedIn";
const STORAGE_TAGS = "gonder.push.tags";
const STORAGE_CONSENT_REQUIRED = "gonder.push.consentRequired";
const STORAGE_CONSENT_GIVEN = "gonder.push.consentGiven";

/**
 * SecureStore keys may only contain alphanumerics, `.`, `-`, and `_`, which the
 * AsyncStorage key already satisfies — kept separate so the two never drift.
 */
const SECURE_DEVICE_ID = "gonder.push.deviceId";

const DEFAULT_BASE_URL = "https://gonder.ai";

let appId: string | null = null;
let baseUrl: string = DEFAULT_BASE_URL;
let externalId: string | null = null;
let deviceToken: string | null = null;
let deviceIdCache: string | null = null;
let subscriptionId: string | null = null;
let userId: string | null = null;
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

interface SecureStoreModule {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(
    key: string,
    value: string,
    options?: Record<string, unknown>
  ): Promise<void>;
}

/** `expo-secure-store` is an optional peer dependency. */
function secureStore(): SecureStoreModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const required = require("expo-secure-store") as Record<string, unknown> & {
      default?: Record<string, unknown>;
    };
    const module = (required.default ?? required) as Partial<SecureStoreModule>;
    if (
      typeof module.getItemAsync === "function" &&
      typeof module.setItemAsync === "function"
    ) {
      return module as SecureStoreModule;
    }
  } catch {
    // not installed — fall back to AsyncStorage
  }
  return null;
}

async function readSecureDeviceId(): Promise<string | null> {
  const store = secureStore();
  if (!store) return null;
  try {
    return await store.getItemAsync(SECURE_DEVICE_ID);
  } catch (error) {
    debugLog(`secure read failed: ${String(error)}`, LogLevel.Warn);
    return null;
  }
}

async function writeSecureDeviceId(value: string): Promise<void> {
  const store = secureStore();
  if (!store) return;
  try {
    await store.setItemAsync(SECURE_DEVICE_ID, value, {
      // Survives reboots without requiring an unlocked device at push time,
      // and is excluded from iCloud/iTunes backups so a restored backup on a
      // second phone does not clone this installation's identity.
      keychainAccessible: (
        store as unknown as { WHEN_UNLOCKED_THIS_DEVICE_ONLY?: unknown }
      ).WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch (error) {
    debugLog(`secure write failed: ${String(error)}`, LogLevel.Warn);
  }
}

/**
 * Stable installation id, stored in the Keychain when `expo-secure-store` is
 * available.
 *
 * iOS clears app storage on uninstall but keeps Keychain entries, so a
 * reinstall reuses this id and updates the existing subscription instead of
 * creating a duplicate. AsyncStorage is still written as a mirror for installs
 * without SecureStore, and an id found only there is promoted to the Keychain.
 */
async function ensureDeviceId(): Promise<string> {
  if (deviceIdCache) return deviceIdCache;

  const secure = await readSecureDeviceId();
  if (secure) {
    deviceIdCache = secure;
    // Keep the mirror in step for code paths that read AsyncStorage directly.
    await persist(STORAGE_DEVICE_ID, secure);
    return secure;
  }

  const legacy = await read(STORAGE_DEVICE_ID);
  if (legacy) {
    deviceIdCache = legacy;
    await writeSecureDeviceId(legacy);
    debugLog("migrated deviceId into secure storage", LogLevel.Debug);
    return legacy;
  }

  const created = createUuid();
  deviceIdCache = created;
  await writeSecureDeviceId(created);
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
    subscriptionId,
    userId,
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

/** Returns the parsed JSON body on success, `null` otherwise. */
async function post(
  path: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  if (!canSendNetwork()) {
    debugLog(`${path} skipped — consent required but not given`, LogLevel.Info);
    return null;
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
    if (!response.ok) {
      debugLog(
        `${path} HTTP ${response.status}: ${text.slice(0, 120)}`,
        LogLevel.Error
      );
      return null;
    }
    debugLog(`${path} ok (${response.status})`, LogLevel.Debug);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  } catch (error) {
    debugLog(`${path} failed: ${String(error)}`, LogLevel.Error);
    return null;
  }
}

interface DeviceContext {
  deviceModel?: string;
  deviceManufacturer?: string;
  osName?: string;
  osVersion?: string;
  osApiLevel?: number;
}

/**
 * Hardware and OS details for the Subscribers dashboard.
 *
 * `expo-device` gives the richest data (iOS hardware identifiers like
 * `iPhone16,2`), but it is optional — React Native's `Platform.constants`
 * covers Android fully and iOS partially when it is not installed.
 */
function collectDeviceContext(): DeviceContext {
  const context: DeviceContext = {};

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const required = require("expo-device") as Record<string, unknown> & {
      default?: Record<string, unknown>;
    };
    const Device = (required.default ?? required) as {
      modelId?: string | null;
      modelName?: string | null;
      manufacturer?: string | null;
      osName?: string | null;
      osVersion?: string | null;
      platformApiLevel?: number | null;
    };
    // modelId is the raw identifier on iOS and empty on Android.
    const model = Device.modelId || Device.modelName;
    if (model) context.deviceModel = model;
    if (Device.manufacturer) context.deviceManufacturer = Device.manufacturer;
    if (Device.osName) context.osName = Device.osName;
    if (Device.osVersion) context.osVersion = Device.osVersion;
    if (typeof Device.platformApiLevel === "number") {
      context.osApiLevel = Device.platformApiLevel;
    }
  } catch {
    // expo-device is an optional peer dependency
  }

  // Narrow view of react-native's Platform: `constants` and `Version` are not
  // in every @types/react-native version this package builds against.
  const runtime = Platform as unknown as {
    Version?: string | number;
    constants?: {
      Model?: string;
      Manufacturer?: string;
      Brand?: string;
      Release?: string;
      Version?: number;
      systemName?: string;
      osVersion?: string;
    };
  };
  const constants = runtime.constants;

  if (Platform.OS === "android") {
    context.deviceModel = context.deviceModel || constants?.Model;
    context.deviceManufacturer =
      context.deviceManufacturer || constants?.Manufacturer || constants?.Brand;
    context.osVersion = context.osVersion || constants?.Release;
    if (context.osApiLevel === undefined && typeof constants?.Version === "number") {
      context.osApiLevel = constants.Version;
    }
    context.osName = context.osName || "Android";
  } else {
    context.deviceManufacturer = context.deviceManufacturer || "Apple";
    context.osVersion =
      context.osVersion ||
      constants?.osVersion ||
      (runtime.Version !== undefined ? String(runtime.Version) : undefined);
    context.osName = context.osName || constants?.systemName || "iOS";
  }

  return context;
}

function deviceTimezone(): { timezone?: string; offsetMinutes: number } {
  let timezone: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    timezone = undefined;
  }
  return { timezone, offsetMinutes: -new Date().getTimezoneOffset() };
}

function deviceLanguage(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || undefined;
  } catch {
    return undefined;
  }
}

async function sendRegistration(token: string): Promise<void> {
  if (!appId) {
    debugLog("register skipped — SDK not initialized", LogLevel.Warn);
    return;
  }
  const id = await ensureDeviceId();
  const language = deviceLanguage();
  const { timezone, offsetMinutes } = deviceTimezone();
  const body: Record<string, unknown> = {
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
    ...collectDeviceContext(),
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
  const response = await post("/api/mobile-push/register", body);
  await handleRegistrationResponse(response);
}

/**
 * Persists the subscription id and owning user id the backend assigned to this
 * installation.
 */
async function handleRegistrationResponse(
  response: Record<string, unknown> | null
): Promise<void> {
  const data = response?.data as Record<string, unknown> | undefined;
  if (!data) return;
  let changed = false;

  const identifier = data.subscriptionId ?? data.subscriberId;
  if (typeof identifier === "string" && identifier.length > 0) {
    if (identifier !== subscriptionId) {
      subscriptionId = identifier;
      await persist(STORAGE_SUBSCRIPTION_ID, identifier);
      debugLog(`subscriptionId=${identifier}`, LogLevel.Info);
      changed = true;
    }
  }

  // Null is meaningful here: it is how the backend reports an anonymous
  // subscription after logout, so it must clear the cached user id.
  const owner = data.userId;
  const nextUserId = typeof owner === "string" && owner.length > 0 ? owner : null;
  if ("userId" in data && nextUserId !== userId) {
    userId = nextUserId;
    await persist(STORAGE_USER_ID, nextUserId);
    debugLog(`userId=${nextUserId ?? "anonymous"}`, LogLevel.Info);
    changed = true;
  }

  if (changed) {
    notifySubscriptionObservers();
  }
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
  subscriptionId = await read(STORAGE_SUBSCRIPTION_ID);
  userId = await read(STORAGE_USER_ID);
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
  // Detach locally up front so the device never reports a stale owner while
  // offline; a successful re-register confirms it with userId: null.
  userId = null;
  await persist(STORAGE_USER_ID, null);
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

/**
 * Gönder subscription id for this installation. Null until the first successful
 * registration; shown as "Subscription ID" in the dashboard.
 */
function getSubscriptionId(): string | null {
  return subscriptionId;
}

/**
 * Gönder user id that owns this installation, shared by every device the same
 * person logs in on. Null while anonymous.
 */
function getUserId(): string | null {
  return userId;
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
  getSubscriptionId,
  getUserId,
  addClickListener,
  addForegroundLifecycleListener,
  addPermissionObserver,
  addSubscriptionObserver,
  addDebugListener,
  clearAllNotifications,
};

export default GonderPush;
