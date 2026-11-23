import { ed25519 } from "@noble/curves/ed25519.js";
import crypto from "crypto";

const _B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Base58btc encoder that strictly preserves leading zero bytes (0x00 -> '1').
 */
export function b58encode(bytes: Uint8Array): string {
  let pad = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      pad++;
    } else {
      break;
    }
  }

  if (bytes.length === pad) {
    return "1".repeat(pad);
  }

  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  const zero = BigInt(0);
  const fiftyEight = BigInt(58);
  const chars: string[] = [];
  while (n > zero) {
    const rem = Number(n % fiftyEight);
    n = n / fiftyEight;
    chars.push(_B58_ALPHABET[rem]);
  }

  return "1".repeat(pad) + chars.reverse().join("");
}

/**
 * Base58btc decoder preserving leading '1' characters as 0x00 bytes.
 */
export function b58decode(encoded: string): Uint8Array {
  if (!encoded) return new Uint8Array(0);
  let pad = 0;
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === "1") pad++;
    else break;
  }

  let n = BigInt(0);
  const fiftyEight = BigInt(58);
  for (let i = pad; i < encoded.length; i++) {
    const idx = _B58_ALPHABET.indexOf(encoded[i]);
    if (idx === -1) {
      throw new Error(`Invalid base58 character at index ${i}`);
    }
    n = n * fiftyEight + BigInt(idx);
  }

  const hex = n === BigInt(0) ? "" : n.toString(16);
  const paddedHex = hex.length % 2 === 1 ? `0${hex}` : hex;
  const tail = paddedHex ? Buffer.from(paddedHex, "hex") : Buffer.alloc(0);
  const out = new Uint8Array(pad + tail.length);
  out.set(tail, pad);
  return out;
}

/**
 * Extracts raw 32-byte Ed25519 public key from a `did:key:z6Mk...` identifier.
 */
export function didToPublicKey(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) {
    throw new Error(`Unsupported DID format: ${did}`);
  }
  const decoded = b58decode(did.slice("did:key:z".length));
  if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error(`DID is not an Ed25519 multicodec key: ${did}`);
  }
  return decoded.slice(2);
}

/**
 * Computes the canonical 16-hex Technocore DID note shard and key.
 */
export function didFingerprint(did: string): {
  fingerprint: string;
  shard: string;
  key: string;
  kvPath: string;
} {
  const fingerprint = crypto.createHash("sha256").update(did, "utf8").digest("hex").slice(0, 16);
  const shard = fingerprint.slice(0, 2);
  const key = fingerprint.slice(2);
  return {
    fingerprint,
    shard,
    key,
    kvPath: `/kv/did-${shard}/${key}`,
  };
}

/**
 * Derives the canonical W3C did:key string from a 32-byte Ed25519 private seed.
 * Multi-codec prefix for Ed25519 public key is [0xed, 0x01].
 */
export function seedToDid(seedHex: string): { did: string; publicKey: Uint8Array; seedBytes: Uint8Array } {
  const seedBytes = Uint8Array.from(Buffer.from(seedHex.replace(/^0x/, ""), "hex"));
  if (seedBytes.length !== 32) {
    throw new Error(`Invalid seed length: expected 32 bytes, got ${seedBytes.length}`);
  }
  const publicKey = ed25519.getPublicKey(seedBytes);
  const rawMulticodec = new Uint8Array(2 + publicKey.length);
  rawMulticodec[0] = 0xed;
  rawMulticodec[1] = 0x01;
  rawMulticodec.set(publicKey, 2);

  const did = `did:key:z${b58encode(rawMulticodec)}`;
  return { did, publicKey, seedBytes };
}

/**
 * Signs a canonical Technocore room message: `<room>|<nonce>|<textBody>`.
 * Returns an unpadded URL-safe Base64 signature string matching Technocore's `_signer`.
 */
export function signRoomMessage(
  seedHex: string,
  room: string,
  nonce: number | string,
  textBody: string
): { signature: string; canonical: string; did: string } {
  const { did, seedBytes } = seedToDid(seedHex);
  const canonical = `${room}|${nonce}|${textBody}`;
  const canonicalBytes = new TextEncoder().encode(canonical);

  const sigBytes = ed25519.sign(canonicalBytes, seedBytes);
  const signature = Buffer.from(sigBytes).toString("base64url");

  return { signature, canonical, did };
}

/**
 * Verifies a Technocore signed room message (`<room>|<nonce>|<textBody>`).
 */
export function verifyRoomMessage(
  did: string,
  room: string,
  nonce: number | string,
  textBody: string,
  signatureBase64Url: string
): boolean {
  try {
    const cleanRoom = room.replace(/^\/r\//, "").replace(/\/$/, "");
    const pubKey = didToPublicKey(did);
    const sigBytes = Uint8Array.from(Buffer.from(signatureBase64Url, "base64url"));
    if (sigBytes.length !== 64) return false;
    const canonicalBytes = new TextEncoder().encode(`${cleanRoom}|${nonce}|${textBody}`);
    return ed25519.verify(sigBytes, canonicalBytes, pubKey);
  } catch {
    return false;
  }
}

/**
 * Signs a Technocore owned KV namespace update (`room-owners` or `room-allow`).
 * Signature covers `<namespace>|<room>|<nonce>|<value>` in UTF-8.
 */
export function signOwnedKvWrite(
  seedHex: string,
  namespace: "room-owners" | "room-allow",
  room: string,
  nonce: number | string,
  value: string
): { signature: string; canonical: string; did: string } {
  const cleanRoom = room.replace(/^\/r\//, "").replace(/\/$/, "");
  const { did, seedBytes } = seedToDid(seedHex);
  const canonical = `${namespace}|${cleanRoom}|${nonce}|${value}`;
  const sigBytes = ed25519.sign(new TextEncoder().encode(canonical), seedBytes);
  const signature = Buffer.from(sigBytes).toString("base64url");
  return { signature, canonical, did };
}

/**
 * Signs raw UTF-8 challenge bytes (e.g. faucet `fund|<ss58>|<nonce>` challenge) with Ed25519.
 */
export function signChallengeBytes(
  seedHex: string,
  message: string
): { sigHex: string; publicKeyHex: string; did: string } {
  const { did, publicKey, seedBytes } = seedToDid(seedHex);
  const sigBytes = ed25519.sign(new TextEncoder().encode(message), seedBytes);
  return {
    sigHex: `0x${Buffer.from(sigBytes).toString("hex")}`,
    publicKeyHex: `0x${Buffer.from(publicKey).toString("hex")}`,
    did,
  };
}

/**
 * Generates an HTLC secret preimage (32 bytes) and its SHA-256 hash.
 */
export function createHtlcLock(): { secret: string; hash: string } {
  const secretBytes = crypto.randomBytes(32);
  const secret = secretBytes.toString("hex");
  const hash = crypto.createHash("sha256").update(secretBytes).digest("hex");
  return { secret, hash };
}
