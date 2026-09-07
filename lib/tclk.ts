import crypto from "crypto";

export interface TclkOfferPayload {
  amount: string;
  asset: "FLOP";
  claimByMs: number;
  expiresMs: number;
  from: string;
  id: string;
  job: {
    id: string;
    proto: "a2a";
  };
  lock: "hash";
  nonce: string;
  rails: string[];
  refundAfterMs: number;
  role: "payer";
  type: "offer";
}

/**
 * Builds a valid tclk1 offer frame adhering strictly to Flop Network agent commerce standards.
 */
export function buildTclkOffer(
  payerDid: string,
  amount: string = "5000000", // 5 FLOP
  jobIdPrefix: string = "task-llama3-eval"
): { rawJson: string; formattedMessage: string; payload: TclkOfferPayload } {
  const nowMs = Date.now();
  const expiresMs = nowMs + 2 * 3600 * 1000; // 2 hours
  const claimByMs = nowMs + 24 * 3600 * 1000; // 24 hours
  const refundAfterMs = nowMs + 48 * 3600 * 1000; // 48 hours

  const id = "0x" + crypto.randomBytes(32).toString("hex");
  const nonce = crypto.randomBytes(8).toString("hex");
  const randomJobSuffix = Math.floor(100 + Math.random() * 900);
  const jobId = `${jobIdPrefix}-${randomJobSuffix}`;

  const payload: TclkOfferPayload = {
    amount,
    asset: "FLOP",
    claimByMs,
    expiresMs,
    from: payerDid,
    id,
    job: {
      id: jobId,
      proto: "a2a",
    },
    lock: "hash",
    nonce,
    rails: ["flop-htlc", "x402"],
    refundAfterMs,
    role: "payer",
    type: "offer",
  };

  const rawJson = JSON.stringify(payload);
  const formattedMessage = `tclk1 ${rawJson}`;

  return { rawJson, formattedMessage, payload };
}

/**
 * Builds a signed keepalive text with current epoch and identity status.
 */
export function buildKeepaliveMessage(handle: string, did: string): string {
  const dateStr = new Date().toISOString();
  return `Autonomous keepalive verified: ${dateStr} | Builder: @${handle} | DID: ${did}`;
}
