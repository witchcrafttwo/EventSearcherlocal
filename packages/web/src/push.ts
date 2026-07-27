import { getVapidPublicKey, saveProfile, savePushSubscription } from "./api";

const PROFILE_KEY = "events-ai-profile-id";

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** VAPID公開鍵(base64url)を Uint8Array に変換 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * 通知を有効化する。
 * SW登録 → 通知許可 → プロフィール保存(エリア/カテゴリ) → Push購読 → サーバー登録。
 * 戻り値はユーザー向けメッセージ。
 */
export async function enablePush(area: string, categories: string[]): Promise<string> {
  if (!isPushSupported()) {
    return "この端末/ブラウザは通知に対応していません（iPhoneはホーム画面に追加すると使えます）。";
  }

  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return "通知が許可されませんでした。ブラウザの設定から許可してください。";
  }

  const publicKey = await getVapidPublicKey();
  if (!publicKey) {
    return "サーバー側の通知設定（VAPID鍵）が未設定です。管理者にお問い合わせください。";
  }

  // プロフィール（通知条件）を保存。エリア＋カテゴリを条件にする。
  const profile = await saveProfile({
    profileId: localStorage.getItem(PROFILE_KEY) ?? undefined,
    childAge: 0,
    interests: categories,
    area,
    notificationLeadDays: 45
  });
  localStorage.setItem(PROFILE_KEY, profile.profileId);

  // 既存購読があれば再利用、無ければ新規購読
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource
    });
  }

  await savePushSubscription(profile.profileId, subscription.toJSON());
  const areaLabel = area ? `「${area}」` : "全地域";
  const catLabel = categories.length > 0 ? `・${categories.join("/")}` : "";
  return `通知を有効にしました（${areaLabel}${catLabel}の新着イベントをお知らせします）。`;
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (!isPushSupported()) return "unsupported";
  return Notification.permission;
}
