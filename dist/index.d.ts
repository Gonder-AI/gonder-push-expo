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
/** Verbosity for SDK logging (least → most). */
declare enum LogLevel {
    None = 0,
    Error = 1,
    Warn = 2,
    Info = 3,
    Debug = 4,
    Verbose = 5
}
interface GonderPushInitOptions {
    /** Public App ID from Gönder → Platforms → Expo (shared with iOS/Android). */
    appId: string;
    /** API base URL. Defaults to https://gonder.ai */
    baseUrl?: string;
}
/** Normalized notification payload delivered to listeners. */
interface GonderNotification {
    title: string | null;
    body: string | null;
    campaignId: string | null;
    url: string | null;
    additionalData: Record<string, unknown>;
}
interface PushSubscriptionState {
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
type ClickListener = (notification: GonderNotification) => void;
/** Return `false` to suppress the system banner when a push arrives in foreground. */
type ForegroundLifecycleListener = (notification: GonderNotification) => boolean | void;
type PermissionObserver = (granted: boolean) => void;
type SubscriptionObserver = (state: PushSubscriptionState) => void;
type DebugListener = (message: string) => void;
declare function initialize(options: GonderPushInitOptions): Promise<void>;
declare function getPermission(): Promise<boolean>;
declare function getCanRequestPermission(): Promise<boolean>;
declare function requestPermission(fallbackToSettings?: boolean): Promise<boolean>;
declare function registerForPushNotifications(): Promise<void>;
declare function setExternalId(id: string): Promise<void>;
declare function removeExternalId(): Promise<void>;
declare function login(id: string): Promise<void>;
declare function logout(): Promise<void>;
declare function getExternalId(): string | null;
declare function unsubscribe(): Promise<void>;
declare function optOut(): Promise<void>;
declare function optIn(): Promise<void>;
declare function isOptedIn(): boolean;
declare function addTag(key: string, value: string): Promise<void>;
declare function addTags(values: Record<string, string>): Promise<void>;
declare function removeTag(key: string): Promise<void>;
declare function removeTags(keys: string[]): Promise<void>;
declare function getTags(): Record<string, string>;
declare function setConsentRequired(required: boolean): Promise<void>;
declare function setConsentGiven(given: boolean): Promise<void>;
declare function setLogLevel(level: LogLevel): void;
declare function getDeviceId(): string;
declare function getDeviceToken(): string | null;
/**
 * Gönder subscription id for this installation. Null until the first successful
 * registration; shown as "Subscription ID" in the dashboard.
 */
declare function getSubscriptionId(): string | null;
/**
 * Gönder user id that owns this installation, shared by every device the same
 * person logs in on. Null while anonymous.
 */
declare function getUserId(): string | null;
declare function addClickListener(listener: ClickListener): () => void;
declare function addForegroundLifecycleListener(listener: ForegroundLifecycleListener): () => void;
declare function addPermissionObserver(observer: PermissionObserver): () => void;
declare function addSubscriptionObserver(observer: SubscriptionObserver): () => void;
declare function addDebugListener(listener: DebugListener): () => void;
declare function clearAllNotifications(): Promise<void>;
declare const GonderPush: {
    initialize: typeof initialize;
    registerForPushNotifications: typeof registerForPushNotifications;
    requestPermission: typeof requestPermission;
    getPermission: typeof getPermission;
    getCanRequestPermission: typeof getCanRequestPermission;
    setExternalId: typeof setExternalId;
    removeExternalId: typeof removeExternalId;
    login: typeof login;
    logout: typeof logout;
    getExternalId: typeof getExternalId;
    unsubscribe: typeof unsubscribe;
    optIn: typeof optIn;
    optOut: typeof optOut;
    isOptedIn: typeof isOptedIn;
    addTag: typeof addTag;
    addTags: typeof addTags;
    removeTag: typeof removeTag;
    removeTags: typeof removeTags;
    getTags: typeof getTags;
    setConsentRequired: typeof setConsentRequired;
    setConsentGiven: typeof setConsentGiven;
    setLogLevel: typeof setLogLevel;
    getDeviceId: typeof getDeviceId;
    getDeviceToken: typeof getDeviceToken;
    getSubscriptionId: typeof getSubscriptionId;
    getUserId: typeof getUserId;
    addClickListener: typeof addClickListener;
    addForegroundLifecycleListener: typeof addForegroundLifecycleListener;
    addPermissionObserver: typeof addPermissionObserver;
    addSubscriptionObserver: typeof addSubscriptionObserver;
    addDebugListener: typeof addDebugListener;
    clearAllNotifications: typeof clearAllNotifications;
};

export { type ClickListener, type DebugListener, type ForegroundLifecycleListener, type GonderNotification, GonderPush, type GonderPushInitOptions, LogLevel, type PermissionObserver, type PushSubscriptionState, type SubscriptionObserver, GonderPush as default };
