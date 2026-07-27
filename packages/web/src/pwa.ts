export function getVapidPublicKey(): string {
  return import.meta.env.VITE_VAPID_PUBLIC_KEY as string;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) {
    throw new Error("このブラウザはService Workerに対応していません");
  }
  return navigator.serviceWorker.register("/sw.js");
}

export async function subscribePushNotifications(): Promise<PushSubscriptionJSON> {
  if (!("Notification" in window) || !("PushManager" in window)) {
    throw new Error("このブラウザはPush通知に対応していません");
  }
  const vapidPublicKey = getVapidPublicKey();
  if (!vapidPublicKey) throw new Error("VITE_VAPID_PUBLIC_KEY が未設定です");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("通知が許可されませんでした");

  const registration = await registerServiceWorker();
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing.toJSON();

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
  });
  return subscription.toJSON();
}

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    output[i] = rawData.charCodeAt(i);
  }
  return output.buffer;
}
