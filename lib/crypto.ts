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
 * Generates an HTLC secret preimage (32 bytes) and its SHA-256 hash.
 */
export function createHtlcLock(): { secret: string; hash: string } {
  const secretBytes = crypto.randomBytes(32);
  const secret = secretBytes.toString("hex");
  const hash = crypto.createHash("sha256").update(secretBytes).digest("hex");
  return { secret, hash };
}
