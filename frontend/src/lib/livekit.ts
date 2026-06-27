/**
 * lib/livekit.ts — Helpers for fetching LiveKit tokens and room utilities.
 */

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

export interface TokenResponse {
  token: string;
  url: string;
  room: string;
  identity: string;
}

/**
 * Fetch a LiveKit JWT token from the backend.
 * @param identity  Participant identity string (e.g. "caller-john" or "watcher-1")
 * @param room      Room name (default: "default-room")
 * @param role      "caller" or "watcher"
 */
export async function fetchToken(
  identity: string,
  room = "default-room",
  role: "caller" | "watcher" = "caller"
): Promise<TokenResponse> {
  const params = new URLSearchParams({ identity, room, role });
  const res = await fetch(`${BACKEND_URL}/token?${params}`);
  if (!res.ok) {
    throw new Error(`Token fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Fetch all appointments from the backend.
 */
export async function fetchAppointments() {
  const res = await fetch(`${BACKEND_URL}/appointments`);
  if (!res.ok) throw new Error("Failed to fetch appointments");
  return res.json();
}

/**
 * Fetch post-call summaries.
 */
export async function fetchSummaries() {
  const res = await fetch(`${BACKEND_URL}/summaries`);
  if (!res.ok) throw new Error("Failed to fetch summaries");
  return res.json();
}

/**
 * Generate a unique caller identity for this session.
 */
export function generateCallerId(): string {
  return `caller-${Math.random().toString(36).slice(2, 8)}`;
}
