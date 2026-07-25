# @gonderai/expo-push

Official Gönder push SDK for Expo (iOS & Android).

Uses **native device tokens** via `expo-notifications` `getDevicePushTokenAsync()`, so Gönder delivers through your existing APNs and FCM credentials — no Expo Push Service required.

## Install

```bash
npx expo install @gonderai/expo-push expo-notifications @react-native-async-storage/async-storage expo-device
```

`expo-device` is optional but recommended — without it the SDK cannot report the
iOS hardware model, so those subscribers show up without a device name.

Add the config plugin to `app.json` / `app.config.js`:

```json
{
  "expo": {
    "plugins": [
      "expo-notifications",
      "@gonderai/expo-push"
    ]
  }
}
```

Then rebuild native projects:

```bash
npx expo prebuild
```

## Usage

```ts
import { GonderPush, LogLevel } from '@gonderai/expo-push';

GonderPush.setLogLevel(LogLevel.Debug);
GonderPush.addClickListener((n) => console.log('opened', n.campaignId, n.url));
GonderPush.addForegroundLifecycleListener(() => true); // return false to suppress

await GonderPush.initialize({ appId: 'YOUR_APP_ID' });
await GonderPush.registerForPushNotifications();

await GonderPush.login('user_123'); // alias of setExternalId
await GonderPush.addTag('plan', 'pro');
await GonderPush.optOut(); // mute delivery (keeps registration)
await GonderPush.optIn();
await GonderPush.logout();
```

## API

| Method | Description |
|--------|-------------|
| `initialize({ appId, baseUrl? })` | Init with public App ID from Gönder → Platforms → Expo |
| `registerForPushNotifications()` | Request permission + register native token |
| `requestPermission(fallbackToSettings?)` | Permission only |
| `getPermission()` / `getCanRequestPermission()` | Permission state |
| `addClickListener` / `addForegroundLifecycleListener` | Notification listeners |
| `addPermissionObserver` / `addSubscriptionObserver` | State observers |
| `login` / `logout` / `setExternalId` / `removeExternalId` / `getExternalId` | Identity |
| `optIn` / `optOut` / `isOptedIn` | Soft mute vs deliver |
| `addTag(s)` / `removeTag(s)` / `getTags` | Segmentation tags |
| `setConsentRequired` / `setConsentGiven` | Privacy gate for network calls |
| `setLogLevel` / `addDebugListener` | Debugging |
| `unsubscribe` / `clearAllNotifications` | Cleanup |
| `getDeviceId` / `getDeviceToken` / `getSubscriptionId` | Device identity |

## Subscription ID

Every installation gets a Gönder **subscription id** on its first successful
registration. It is the identifier shown in the dashboard's Subscribers table and
the stable handle to use when referencing a device from your backend.

```ts
GonderPush.getSubscriptionId(); // null until the first register call succeeds

GonderPush.addSubscriptionObserver((state) => {
  console.log(state.subscriptionId, state.externalId);
});
```

## Reported device context

Alongside the push token the SDK reports device model, manufacturer, OS name and
version, language and timezone so subscribers can be segmented and identified in
the dashboard. No advertising id and no contact data are collected.

## App ID

Your App ID is a public UUID shared across iOS, Android, and Expo SDKs for the organization. Find it under **Platforms → Expo** (or iOS / Android) in the Gönder dashboard.
