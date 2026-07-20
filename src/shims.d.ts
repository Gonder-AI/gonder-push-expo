declare module "@react-native-async-storage/async-storage" {
  const AsyncStorage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  };
  export default AsyncStorage;
}

declare module "react-native" {
  export const Platform: {
    OS: "ios" | "android" | "web" | string;
    select: <T>(spec: { ios?: T; android?: T; default?: T }) => T;
  };
  export const Linking: {
    openSettings?: () => Promise<void>;
  };
}

declare module "expo-notifications" {
  export type EventSubscription = { remove: () => void };
  export type NotificationContent = {
    title?: string | null;
    body?: string | null;
    data?: Record<string, unknown>;
  };
  export type Notification = {
    request: { content: NotificationContent };
  };
  export type NotificationResponse = {
    notification: Notification;
  };
  export type DevicePushToken = { type: string; data: string };
  export const AndroidImportance: { HIGH: number };
  export function setNotificationHandler(handler: {
    handleNotification: (notification: Notification) => Promise<{
      shouldShowAlert?: boolean;
      shouldShowBanner?: boolean;
      shouldShowList?: boolean;
      shouldPlaySound?: boolean;
      shouldSetBadge?: boolean;
    }>;
  }): void;
  export function addNotificationResponseReceivedListener(
    listener: (response: NotificationResponse) => void
  ): EventSubscription;
  export function addNotificationReceivedListener(
    listener: (notification: Notification) => void
  ): EventSubscription;
  export function addPushTokenListener(
    listener: (token: DevicePushToken) => void
  ): EventSubscription;
  export function getPermissionsAsync(): Promise<{
    status: string;
    canAskAgain?: boolean;
  }>;
  export function requestPermissionsAsync(): Promise<{
    status: string;
    canAskAgain?: boolean;
  }>;
  export function getDevicePushTokenAsync(): Promise<DevicePushToken>;
  export function setNotificationChannelAsync(
    id: string,
    channel: Record<string, unknown>
  ): Promise<void>;
  export function dismissAllNotificationsAsync(): Promise<void>;
}

declare module "expo-constants" {
  const Constants: {
    expoConfig?: {
      ios?: { bundleIdentifier?: string };
      android?: { package?: string };
    };
  };
  export default Constants;
}
