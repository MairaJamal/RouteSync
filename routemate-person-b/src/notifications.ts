/* Day 10: In-app notification feed — pure, synchronous, no network,
 * so it's unit-testable without mocks. Mirrors the notifications
 * table + trigger logic in
 * supabase/migrations/20260906000000_notifications.sql, the same way
 * poolingCapacity.ts mirrors book_pooled_ride()/respond_to_ride_consent().
 *
 * WHY A FEED AND NOT PUSH: a real push/SMS notification needs a
 * device token or a phone number for the *rider themselves* (not
 * just their emergency contacts, which is all that's stored today —
 * see safety.ts) and an external provider (FCM/Twilio) this project
 * has no credentials for. This feed is the real, working fix for
 * "a rider doesn't know a vote is waiting on them" that ships today;
 * it's also the natural place to plug in real push later without
 * re-architecting anything, since the event-producing side (this
 * file) is already decoupled from delivery. */
import { AppNotification, NotificationKind } from "./types";

const notificationsByUser = new Map<string, AppNotification[]>();
let counter = 0;

export function pushNotification(
  input: Omit<AppNotification, "id" | "created_at" | "read_at">,
  now: Date = new Date()
): AppNotification {
  const notification: AppNotification = {
    ...input,
    id: `notif-${now.getTime()}-${counter++}`,
    created_at: now.toISOString(),
    read_at: null,
  };
  const list = notificationsByUser.get(input.user_id) ?? [];
  list.unshift(notification); // newest first, matching the feed's expected order
  notificationsByUser.set(input.user_id, list);
  return notification;
}

export function listNotifications(userId: string): AppNotification[] {
  return notificationsByUser.get(userId) ?? [];
}

export function unreadCount(userId: string): number {
  return listNotifications(userId).filter((n) => !n.read_at).length;
}

export function markNotificationRead(
  userId: string,
  notificationId: string,
  now: Date = new Date()
): boolean {
  const notification = listNotifications(userId).find((n) => n.id === notificationId);
  if (!notification || notification.read_at) return false;
  notification.read_at = now.toISOString();
  return true;
}

export function markAllNotificationsRead(userId: string, now: Date = new Date()): number {
  let count = 0;
  for (const n of listNotifications(userId)) {
    if (!n.read_at) {
      n.read_at = now.toISOString();
      count++;
    }
  }
  return count;
}

/** Test-only: clears every user's notifications so suites don't leak
 *  state into each other via the shared module-level Map. */
export function __resetNotificationsForTests(): void {
  notificationsByUser.clear();
  counter = 0;
}

export function notificationText(kind: NotificationKind, params: { joinerName: string }): {
  title: string;
  body: string;
} {
  switch (kind) {
    case "consent_requested":
      return {
        title: "Group approval needed",
        body: `${params.joinerName} wants to join your shared ride. Everyone in the group needs to agree.`,
      };
    case "consent_reminder":
      return {
        title: "5 minutes left to respond",
        body: `${params.joinerName}'s join request expires soon — vote now or the seat will be released.`,
      };
    case "consent_resolved":
      return {
        title: "Your request was answered",
        body: `The group finished voting on your join request.`,
      };
    case "consent_expired":
      return {
        title: "Join request expired",
        body: `Nobody finished voting in time, so your request to join was automatically cancelled.`,
      };
  }
}
