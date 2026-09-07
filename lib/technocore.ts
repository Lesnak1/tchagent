import { signRoomMessage, seedToDid } from "./crypto";
import { buildTclkOffer } from "./tclk";

export const DEFAULT_TECHNOCORE_URL = "https://technocore.chat";
export const REAP_WINDOW_HOURS = 168; // 7 days = 168 hours

export interface RoomMessage {
  seq: number;
  ts: string;
  sender: string;
  text: string;
  sig?: string;
  nonce?: number;
}

export interface RoomHealth {
  room: string;
  exists: boolean;
  totalMessages: number;
  lastMessageAt: string | null;
  hoursSinceLastMessage: number;
  hoursUntilReap: number;
  isExpiringSoon: boolean; // < 48 hours remaining
  ownerDid: string | null;
  isOwnerVerified: boolean;
  messages: RoomMessage[];
}

export interface CycleResult {
  success: boolean;
  timestamp: string;
  room: string;
  payerDid: string;
  nonce: number;
  messageType: "tclk_offer" | "keepalive";
  technocoreStatus: number;
  responseText: string;
  preCycleHealth: RoomHealth;
  postCycleHealth?: RoomHealth;
}

/**
 * Fetches the live messages and health of a Technocore room.
 */
export async function getRoomHealth(
  room: string,
  serverUrl: string = DEFAULT_TECHNOCORE_URL,
  expectedOwnerDid?: string
): Promise<RoomHealth> {
  const cleanRoom = room.replace(/^\/r\//, "").replace(/\/$/, "");
  const roomUrl = `${serverUrl}/r/${cleanRoom}?format=json`;

  let messages: RoomMessage[] = [];
  let totalMessages = 0;
  let lastMessageAt: string | null = null;
  let exists = false;

  try {
    const res = await fetch(roomUrl, {
      headers: { "User-Agent": "TechnocoreAgentBot/1.0" },
      cache: "no-store",
    });

    if (res.status === 200) {
      exists = true;
      const data = await res.json();
      if (Array.isArray(data.messages)) {
        messages = data.messages.map((m: any, idx: number) => ({
          seq: m.seq || idx + 1,
          ts: m.ts || m.time || new Date().toISOString(),
          sender: m.from || m.sender || m.nick || "unknown",
          text: m.text || m.body || "",
          sig: m.sig,
          nonce: m.nonce,
        }));
        totalMessages = messages.length;
        if (messages.length > 0) {
          lastMessageAt = messages[messages.length - 1].ts;
        }
      }
    } else if (res.status === 404) {
      exists = false;
    }
  } catch (err) {
    // Fallback: fetch plain text view if json fails
    try {
      const textRes = await fetch(`${serverUrl}/r/${cleanRoom}`, {
        headers: { "User-Agent": "TechnocoreAgentBot/1.0" },
        cache: "no-store",
      });
      if (textRes.status === 200) {
        exists = true;
        const body = await textRes.text();
        const lines = body.split("\n");
        for (const line of lines) {
          const match = line.match(/^\[(\d+)\]\s+([\d-T:.Z]+)\s+<([^>]+)>\s+(.*)$/);
          if (match) {
            messages.push({
              seq: parseInt(match[1], 10),
              ts: match[2],
              sender: match[3],
              text: match[4],
            });
          }
        }
        totalMessages = messages.length;
        if (messages.length > 0) {
          lastMessageAt = messages[messages.length - 1].ts;
        }
      }
    } catch {
      // Ignored
    }
  }

  // Fetch owner note from /kv/room-owners/<room>
  let ownerDid: string | null = null;
  try {
    const ownerRes = await fetch(`${serverUrl}/kv/room-owners/${cleanRoom}`, {
      headers: { "User-Agent": "TechnocoreAgentBot/1.0" },
      cache: "no-store",
    });
    if (ownerRes.status === 200) {
      ownerDid = (await ownerRes.text()).trim();
    }
  } catch {
    // Ignored
  }

  let hoursSinceLastMessage = 0;
  if (lastMessageAt) {
    const elapsedMs = Math.max(0, Date.now() - new Date(lastMessageAt).getTime());
    hoursSinceLastMessage = Math.round((elapsedMs / (1000 * 3600)) * 10) / 10;
  } else {
    hoursSinceLastMessage = REAP_WINDOW_HOURS; // Assume full window if no message
  }

  const hoursUntilReap = Math.max(0, Math.round((REAP_WINDOW_HOURS - hoursSinceLastMessage) * 10) / 10);
  const isExpiringSoon = hoursUntilReap < 48;
  const isOwnerVerified = expectedOwnerDid ? ownerDid === expectedOwnerDid : Boolean(ownerDid);

  return {
    room: cleanRoom,
    exists,
    totalMessages,
    lastMessageAt,
    hoursSinceLastMessage,
    hoursUntilReap,
    isExpiringSoon,
    ownerDid,
    isOwnerVerified,
    messages: messages.slice(-15), // keep last 15 for dashboard display
  };
}

/**
 * Dispatches a signed message to the Technocore server.
 */
export async function postSignedTechnocoreMessage(
  seedHex: string,
  room: string,
  nonce: number,
  textBody: string,
  serverUrl: string = DEFAULT_TECHNOCORE_URL
): Promise<{ status: number; text: string; did: string; signature: string }> {
  const cleanRoom = room.replace(/^\/r\//, "").replace(/\/$/, "");
  const { signature, did } = signRoomMessage(seedHex, cleanRoom, nonce, textBody);
  const encodedText = encodeURIComponent(textBody);

  const targetUrl = `${serverUrl}/r/${cleanRoom}/say-signed/${did}/${signature}/${nonce}/${encodedText}`;

  const res = await fetch(targetUrl, {
    method: "GET",
    headers: {
      "User-Agent": "FlopNetwork-AutonomousAgent/1.0",
    },
    cache: "no-store",
  });

  const responseText = await res.text();
  return {
    status: res.status,
    text: responseText,
    did,
    signature,
  };
}

/**
 * Full autonomous cycle:
 * 1. Measures room health.
 * 2. Generates an authentic TCLK agent commerce offer with HTLC lock.
 * 3. Signs and commits the message to the room with an incremental millisecond nonce.
 * 4. Confirms 200 OK.
 */
export async function runAutonomousKeepaliveCycle(
  seedHex: string,
  room: string,
  serverUrl: string = DEFAULT_TECHNOCORE_URL,
  amount: string = "5000000" // 5 FLOP
): Promise<CycleResult> {
  const { did } = seedToDid(seedHex);
  const preHealth = await getRoomHealth(room, serverUrl, did);

  // Nonce generation: strictly increasing current epoch millisecond timestamp
  const nonce = Date.now();

  // Generate authentic TCLK/1 protocol offer
  const { formattedMessage } = buildTclkOffer(did, amount);

  const postResult = await postSignedTechnocoreMessage(
    seedHex,
    room,
    nonce,
    formattedMessage,
    serverUrl
  );

  const success = postResult.status === 200;

  let postHealth: RoomHealth | undefined;
  if (success) {
    // Re-verify room state
    postHealth = await getRoomHealth(room, serverUrl, did);
  }

  return {
    success,
    timestamp: new Date().toISOString(),
    room,
    payerDid: did,
    nonce,
    messageType: "tclk_offer",
    technocoreStatus: postResult.status,
    responseText: postResult.text,
    preCycleHealth: preHealth,
    postCycleHealth: postHealth,
  };
}
