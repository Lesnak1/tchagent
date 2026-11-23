import { didFingerprint, signOwnedKvWrite, signRoomMessage, seedToDid } from "./crypto";
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
  didNotePath: string | null;
  didNoteExists: boolean;
  didNoteValue: string | null;
  messages: RoomMessage[];
}

export interface IdentitySyncResult {
  room: string;
  did: string;
  didNotePath: string;
  ownerSynced: boolean;
  ownerUnclaimable: boolean;
  ownerStatus: number;
  ownerResponse: string;
  ownerConflict: string | null;
  didNoteSynced: boolean;
  didNoteStatus: number;
  didNoteResponse: string;
  nonce: number;
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
  identitySync?: IdentitySyncResult;
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
        messages = (data.messages as Array<Record<string, unknown>>).map((m, idx: number) => ({
          seq: typeof m.seq === "number" ? m.seq : idx + 1,
          ts: (typeof m.ts === "string" ? m.ts : typeof m.time === "string" ? m.time : new Date().toISOString()),
          sender: (typeof m.from === "string" ? m.from : typeof m.sender === "string" ? m.sender : typeof m.nick === "string" ? m.nick : "unknown"),
          text: (typeof m.text === "string" ? m.text : typeof m.body === "string" ? m.body : ""),
          sig: typeof m.sig === "string" ? m.sig : undefined,
          nonce: typeof m.nonce === "number" ? m.nonce : undefined,
        }));
        totalMessages = messages.length;
        if (messages.length > 0) {
          lastMessageAt = messages[messages.length - 1].ts;
        }
      }
    } else if (res.status === 404) {
      exists = false;
    }
  } catch {
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

  // Fetch DID identity note if target DID is known
  const targetDid = expectedOwnerDid || ownerDid;
  let didNotePath: string | null = null;
  let didNoteExists = false;
  let didNoteValue: string | null = null;
  if (targetDid && targetDid.startsWith("did:key:")) {
    const fp = didFingerprint(targetDid);
    didNotePath = fp.kvPath;
    try {
      const noteRes = await fetch(`${serverUrl}${fp.kvPath}`, {
        headers: { "User-Agent": "TechnocoreAgentBot/1.0" },
        cache: "no-store",
      });
      if (noteRes.status === 200) {
        didNoteExists = true;
        didNoteValue = (await noteRes.text()).trim();
      }
    } catch {
      // Ignored
    }
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
    didNotePath,
    didNoteExists,
    didNoteValue,
    messages: messages.slice(-15), // keep last 15 for dashboard display
  };
}

/**
 * Reclaims or refreshes signed KV ownership (`/kv/room-owners/<room>`) and
 * refreshes the agent's public DID profile note (`/kv/did-<shard>/<key>`),
 * resetting their 7-day KV expiry timers on Technocore.
 */
export async function syncRoomOwnershipAndDidNote(
  seedHex: string,
  room: string,
  serverUrl: string = DEFAULT_TECHNOCORE_URL
): Promise<IdentitySyncResult> {
  const cleanRoom = room.replace(/^\/r\//, "").replace(/\/$/, "");
  const { did } = seedToDid(seedHex);
  const fp = didFingerprint(did);

  // Inspect existing room owner & monotonic room-nonce counter
  let existingOwner: string | null = null;
  let ownerLookupStatus = 404;
  try {
    const ownerRes = await fetch(`${serverUrl}/kv/room-owners/${cleanRoom}`, {
      headers: { "User-Agent": "TechnocoreAgentBot/1.0" },
      cache: "no-store",
    });
    ownerLookupStatus = ownerRes.status;
    if (ownerRes.status === 200) {
      existingOwner = (await ownerRes.text()).trim();
    }
  } catch {
    // Proceed with claim check on failure
  }

  let lastRoomNonce = 0;
  try {
    const nonceRes = await fetch(`${serverUrl}/kv/room-nonce/${cleanRoom}`, {
      headers: { "User-Agent": "TechnocoreAgentBot/1.0" },
      cache: "no-store",
    });
    if (nonceRes.status === 200) {
      const parsed = Number.parseInt((await nonceRes.text()).trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        lastRoomNonce = parsed;
      }
    }
  } catch {
    // Ignore
  }

  const nonce = Math.max(Date.now(), lastRoomNonce + 1);
  let ownerSynced = false;
  let ownerUnclaimable = false;
  let ownerStatus = ownerLookupStatus;
  let ownerResponse = "";
  let ownerConflict: string | null = null;

  if (existingOwner && existingOwner !== did) {
    ownerConflict = existingOwner;
    ownerResponse = `Room ${cleanRoom} is owned by another DID (${existingOwner})`;
  } else {
    const { signature } = signOwnedKvWrite(seedHex, "room-owners", cleanRoom, nonce, did);
    const ifAbsentSuffix = existingOwner === null ? "?if_absent=1" : "";
    const claimUrl = `${serverUrl}/kv/room-owners/${cleanRoom}/set-signed/${did}/${signature}/${nonce}/${encodeURIComponent(did)}${ifAbsentSuffix}`;
    const writeRes = await fetch(claimUrl, {
      method: "GET",
      headers: { "User-Agent": "TechnocoreAgentBot/1.0" },
      cache: "no-store",
    });
    ownerStatus = writeRes.status;
    ownerResponse = (await writeRes.text()).trim();
    ownerSynced = writeRes.status === 200;
    if (writeRes.status === 403 && ownerResponse.toLowerCase().includes("already has messages")) {
      ownerUnclaimable = true;
    }
  }

  // Publish/refresh the single-line DID identity note (`patterns.md` §§3 & 6)
  const noteValue = `${did} room:${cleanRoom} tclk1:flop-htlc,x402`;
  const noteUrl = `${serverUrl}${fp.kvPath}/set/${encodeURIComponent(noteValue)}`;
  const noteRes = await fetch(noteUrl, {
    method: "GET",
    headers: { "User-Agent": "TechnocoreAgentBot/1.0" },
    cache: "no-store",
  });
  const didNoteStatus = noteRes.status;
  const didNoteResponse = (await noteRes.text()).trim();
  const didNoteSynced = noteRes.status === 200;

  return {
    room: cleanRoom,
    did,
    didNotePath: fp.kvPath,
    ownerSynced,
    ownerUnclaimable,
    ownerStatus,
    ownerResponse,
    ownerConflict,
    didNoteSynced,
    didNoteStatus,
    didNoteResponse,
    nonce,
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
  const identitySync = await syncRoomOwnershipAndDidNote(seedHex, room, serverUrl);

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
    identitySync,
    preCycleHealth: preHealth,
    postCycleHealth: postHealth,
  };
}
