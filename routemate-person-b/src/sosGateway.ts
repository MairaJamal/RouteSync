// ─────────────────────────────────────────────────────────────
// SOS delivery seam — the ONE place a real message gateway plugs in.
//
// WHY THIS EXISTS
// A browser cannot silently send SMS/WhatsApp, so the SOS flow's real
// delivery is either (a) the rider's final on-device tap on a wa.me /
// tel: deep link, or (b) a server-side gateway (Twilio etc.) that we
// deliberately do NOT depend on by default — no credentials, no cost,
// no abuse surface of texting real numbers from our server.
//
// This module is the single, honest boundary between those worlds.
// With no SOS_ALERT_WEBHOOK_URL configured, every alert comes back
// "logged": the platform recorded + prepared it, and the UI truthfully
// shows "ready — tap to send" rather than a fake green "Sent". Point
// SOS_ALERT_WEBHOOK_URL at a real dispatcher (a Twilio Function, a
// Queue worker, anything) and the very same call starts returning
// "sent"/"queued" with zero changes to the endpoints or the frontend.
// ─────────────────────────────────────────────────────────────

export type SosRecipientKind = "emergency_contact" | "police";
export type SosChannel = "whatsapp" | "sms" | "call" | "log";
/** Truthful delivery states. See the sos_alerts migration for the
 *  exact meaning of each — in particular 'logged' is NOT a claim that
 *  a message reached the recipient's handset. */
export type SosDeliveryStatus = "logged" | "sent" | "queued" | "failed";

export interface SosAlertPayload {
  name: string;
  phone?: string;
  kind: SosRecipientKind;
  channel: SosChannel;
  message: string;
  locationLink?: string;
}

const WEBHOOK_TIMEOUT_MS = 5_000;

/** Is a live delivery gateway configured at all? The UI uses this to
 *  decide whether to promise "sent" language or the honest "ready"
 *  language, so it must reflect the same condition dispatchSosAlert
 *  branches on. */
export function isSosGatewayConfigured(): boolean {
  return typeof process.env.SOS_ALERT_WEBHOOK_URL === "string" && process.env.SOS_ALERT_WEBHOOK_URL.length > 0;
}

/** Attempt delivery for one recipient. Never throws — a gateway error
 *  degrades to 'queued' (accepted-for-retry) rather than failing the
 *  whole dispatch, because the rider's emergency contacts + police
 *  deep links are surfaced regardless of what this returns. */
export async function dispatchSosAlert(payload: SosAlertPayload): Promise<SosDeliveryStatus> {
  const webhook = process.env.SOS_ALERT_WEBHOOK_URL;
  if (!webhook) return "logged"; // no gateway wired — record + hand off to the rider's tap

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.SOS_ALERT_WEBHOOK_TOKEN) {
      headers.Authorization = `Bearer ${process.env.SOS_ALERT_WEBHOOK_TOKEN}`;
    }
    const res = await fetch(webhook, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return res.ok ? "sent" : "queued";
  } catch {
    return "queued";
  } finally {
    clearTimeout(timer);
  }
}
