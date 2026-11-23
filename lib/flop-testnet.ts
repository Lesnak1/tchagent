import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  FLOP_DECIMALS,
  FLOP_SS58_FORMAT,
  FlopClient as FlopChainClient,
  type FlopNetwork,
  type InferencePurchaseIntent,
  type InferenceReceipt,
  formatFlop,
  getFlopNetworkProfile,
  isFlopNetwork,
  requestFaucetFunding,
} from '@flop-labs/sdk';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import {
  seedToDid,
  signChallengeBytes,
  verifyRoomMessage,
} from './crypto';
import { type FlopModelInfo, getLiveFlopModels } from './flop';
import { DEFAULT_TECHNOCORE_URL, getRoomHealth, postSignedTechnocoreMessage } from './technocore';

export interface FlopTestnetEnvConfig {
  network: FlopNetwork;
  rpcUrl: string;
  gatewayUrl: string;
  faucetUrl: string | null;
  explorerUrl: string;
  apiKey?: string;
  substrateUri?: string;
  minerUrl?: string;
  roomName: string;
  technocoreUrl: string;
  stateFilePath: string;
}

export interface FaucetChainMetadata {
  network: string;
  chain?: string;
  genesisHash: string;
  caip2?: string;
  ss58Format?: number;
  decimals?: number;
  tokenSymbol?: string;
  rpc?: string;
  technocoreBot?: {
    did: string;
    room: string;
  };
}

export interface LocalAgentState {
  address?: string;
  network?: string;
  lastFaucetAttemptAt?: string;
  lastFaucetOutcome?: string;
  lastFaucetTxHash?: string;
  lastSpendAt?: string;
  pendingPurchaseIntents?: Record<string, InferencePurchaseIntent>;
  completedSessions?: Array<{
    timestamp: string;
    mode: 'direct-channel' | 'gateway';
    model: string;
    channelId?: string;
    correlationId?: string;
    gnUsed?: string;
    txOrReceiptId?: string;
  }>;
}

export interface DerivedSubstrateIdentity {
  did: string;
  ss58Address: string;
  pair: KeyringPair;
}

export interface OrganicTaskSpec {
  id: string;
  topic: string;
  systemPrompt: string;
  turns: [string, string];
}

const FAU_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function getFlopNetworkConfig(networkOverride?: FlopNetwork): FlopTestnetEnvConfig {
  const rawNet = (networkOverride || process.env.FLOP_NETWORK || 'testnet').toLowerCase();
  const network: FlopNetwork = isFlopNetwork(rawNet) ? rawNet : 'testnet';
  const profile = getFlopNetworkProfile(network);

  const explorerDefault =
    network === 'devnet'
      ? 'https://explorer.devnet.flop.network'
      : 'https://explorer.testnet.flop.network';

  return {
    network,
    rpcUrl: (process.env.FLOP_RPC_URL || profile.rpc).trim(),
    gatewayUrl: (process.env.FLOP_GATEWAY_URL || profile.gateway).trim(),
    faucetUrl:
      process.env.FLOP_FAUCET_URL !== undefined
        ? process.env.FLOP_FAUCET_URL.trim() || null
        : profile.faucet,
    explorerUrl: (process.env.FLOP_EXPLORER_URL || explorerDefault).trim(),
    apiKey: process.env.FLOP_API_KEY?.trim() || undefined,
    substrateUri: process.env.FLOP_SUBSTRATE_URI?.trim() || undefined,
    minerUrl: process.env.FLOP_MINER_URL?.trim() || undefined,
    roomName: (process.env.ROOM_NAME || 'd-lesnak1').trim(),
    technocoreUrl: (process.env.TECHNOCORE_URL || DEFAULT_TECHNOCORE_URL).trim(),
    stateFilePath: path.resolve(process.cwd(), '.flop-agent-state.json'),
  };
}

/**
 * Derives one consistent Substrate Ed25519 account (SS58 prefix 42) and W3C
 * did:key from `AGENT_SEED`, preventing multi-wallet / sybil drift.
 */
export async function deriveAgentSubstrateIdentity(
  seedHex: string,
  explicitSubstrateUri?: string
): Promise<DerivedSubstrateIdentity> {
  await cryptoWaitReady();
  const { did, seedBytes } = seedToDid(seedHex);
  const keyring = new Keyring({ type: 'ed25519', ss58Format: FLOP_SS58_FORMAT });
  const pair = explicitSubstrateUri
    ? keyring.addFromUri(explicitSubstrateUri)
    : keyring.addFromSeed(seedBytes);

  return {
    did,
    ss58Address: pair.address,
    pair,
  };
}

export function loadLocalAgentState(stateFilePath: string): LocalAgentState {
  try {
    if (!fs.existsSync(stateFilePath)) return {};
    const raw = fs.readFileSync(stateFilePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as LocalAgentState;
    }
    return {};
  } catch {
    return {};
  }
}

export function saveLocalAgentState(stateFilePath: string, state: LocalAgentState): void {
  fs.writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export async function fetchFaucetChainMetadata(
  faucetUrl: string
): Promise<{ ok: boolean; status: number; data?: FaucetChainMetadata; error?: string }> {
  const base = faucetUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/chain`, {
      headers: { Accept: 'application/json', 'User-Agent': 'TechnocoreAgentBot/1.0' },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as FaucetChainMetadata;
    return { ok: true, status: res.status, data };
  } catch (err: unknown) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function buildOrganicAgentTask(seedIndex?: number): OrganicTaskSpec {
  const daySeed = new Date().toISOString().slice(0, 10);
  const tasks: OrganicTaskSpec[] = [
    {
      id: `substrate-invariants-${daySeed}`,
      topic: 'Substrate pallet escrow invariants',
      systemPrompt:
        'You are a careful systems engineer analyzing state-transition invariants. Keep answers concrete and concise.',
      turns: [
        `[${daySeed}] Explain three failure modes when settling an off-chain payment channel against an on-chain escrow with finite dispute windows, and how strict nonce monotonicity prevents replay.`,
        'Now write a minimal checklist of invariant assertions an automated integration test should check after force_settle followed by finalize.',
      ],
    },
    {
      id: `distributed-idempotency-${daySeed}`,
      topic: 'Idempotent API reconciliation after network timeouts',
      systemPrompt:
        'You are a reliability engineer designing payment clients. Focus on ambiguous timeout handling.',
      turns: [
        `[${daySeed}] Why should a client never automatically retry a POST fund or settlement request after an HTTP 503 or socket timeout? Contrast at-least-once delivery with idempotency-key reconciliation.`,
        'Give a compact state machine (states + allowed transitions) for recovering cleanly from an unknown transaction outcome.',
      ],
    },
    {
      id: `ed25519-multicodec-${daySeed}`,
      topic: 'Ed25519 did:key verification and canonical signing',
      systemPrompt:
        'You are a cryptography engineer reviewing message authentication protocols.',
      turns: [
        `[${daySeed}] Explain why domain-separating signed payloads (e.g. "<namespace>|<room>|<nonce>|<value>") prevents cross-protocol signature reuse, and why unpadded base64url canonical checks matter.`,
        'List 4 concrete unit tests that verify signature rejection on tampered delimiters, replayed nonces, and trailing padding.',
      ],
    },
    {
      id: `poui-microstructure-${daySeed}`,
      topic: 'Verifiable decentralized inference economics',
      systemPrompt:
        'You are a protocol economist evaluating Proof-of-Useful-Inference compute markets.',
      turns: [
        `[${daySeed}] Compare fixed per-token posted pricing vs. challenger-verified execution quotes in decentralized GPU networks. How do dispute windows deter lazy inference?',`,
        'Summarize two quantitative metrics a dashboard should track to spot latency degradation before slash thresholds trigger.',
      ],
    },
  ];

  const idx =
    typeof seedIndex === 'number' && Number.isFinite(seedIndex)
      ? Math.abs(Math.floor(seedIndex)) % tasks.length
      : Math.floor(Date.now() / 86_400_000) % tasks.length;

  return tasks[idx] ?? tasks[0];
}

export async function probeTestnetHealth(
  seedHex: string,
  config: FlopTestnetEnvConfig,
  options: { allowDevnetProbe?: boolean } = {}
): Promise<void> {
  const identity = await deriveAgentSubstrateIdentity(seedHex, config.substrateUri);
  const roomHealth = await getRoomHealth(config.roomName, config.technocoreUrl, identity.did);
  const state = loadLocalAgentState(config.stateFilePath);

  console.log('================================================================');
  console.log('FLOP NETWORK TESTNET (ERA-T) PRE-FLIGHT DOCTOR');
  console.log('================================================================');
  console.log(`Target Network    : ${config.network.toUpperCase()}`);
  console.log(`Agent DID         : ${identity.did}`);
  console.log(`Substrate SS58(42): ${identity.ss58Address}`);
  console.log(`Technocore Room   : /r/${roomHealth.room} (${roomHealth.exists ? 'LIVE' : 'MISSING'}, ${roomHealth.totalMessages} msgs, reap in ${roomHealth.hoursUntilReap}h)`);
  console.log(`DID Note KV       : ${roomHealth.didNotePath ?? 'n/a'} (${roomHealth.didNoteExists ? 'HTTP 200 OK' : 'MISSING'})`);
  console.log(`Configured RPC    : ${config.rpcUrl}`);
  console.log(`Configured Gateway: ${config.gatewayUrl}`);
  console.log(`Configured Faucet : ${config.faucetUrl ?? 'none'}`);
  console.log(`Local State File  : ${config.stateFilePath}`);
  console.log(`Last Faucet Claim : ${state.lastFaucetAttemptAt ?? 'none'} (${state.lastFaucetOutcome ?? 'n/a'})`);
  console.log('----------------------------------------------------------------');

  if (config.faucetUrl) {
    const chainMeta = await fetchFaucetChainMetadata(config.faucetUrl);
    if (chainMeta.ok && chainMeta.data) {
      console.log(`Faucet /chain     : REACHABLE (${chainMeta.data.network}, genesis ${chainMeta.data.genesisHash.slice(0, 14)}...)`);
      if (chainMeta.data.technocoreBot) {
        console.log(`Faucet Bot        : room=/r/${chainMeta.data.technocoreBot.room} did=${chainMeta.data.technocoreBot.did}`);
      }
    } else {
      console.log(`Faucet /chain     : NOT LIVE YET (${chainMeta.error ?? `HTTP ${chainMeta.status}`})`);
    }
  }

  const gwModels = await getLiveFlopModels(config.gatewayUrl);
  console.log(`Gateway /v1/models: ${gwModels.length > 0 ? `ONLINE (${gwModels.length} models)` : 'NOT LIVE YET / UNREACHABLE'}`);

  if (options.allowDevnetProbe && config.network !== 'devnet') {
    const devnet = getFlopNetworkProfile('devnet');
    const devChain = devnet.faucet ? await fetchFaucetChainMetadata(devnet.faucet) : { ok: false, status: 0 };
    const devModels = await getLiveFlopModels(devnet.gateway);
    console.log('----------------------------------------------------------------');
    console.log(`Devnet Baseline   : faucet=${devChain.ok ? `OK (${devChain.data?.technocoreBot?.room ?? 'no-bot'})` : 'ERR'}, models=${devModels.length}`);
  }

  // Check on-chain RPC connectivity & balance when live
  try {
    const chainClient = await FlopChainClient.createWithKeypair(config.rpcUrl, identity.pair);
    try {
      const info = await chainClient.getAccountInfo(identity.ss58Address);
      const health = await chainClient.health();
      console.log(`RPC Node Status   : CONNECTED (peers=${health.peers}, syncing=${health.isSyncing})`);
      console.log(`On-Chain Balance  : ${formatFlop(info.free)} FLOP free (decimals=${FLOP_DECIMALS})`);
    } finally {
      await chainClient.disconnect();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`RPC Node Status   : NOT REACHABLE YET (${msg.slice(0, 120)})`);
  }

  console.log('----------------------------------------------------------------');
  console.log('Readiness Summary : Launch opens 2026-11-24 07:00 UTC (10:00 TSI).');
  console.log('When links publish, update .env.local (if URLs differ from defaults)');
  console.log('and run: npm run flop-testnet:run');
  console.log('================================================================');
}

/**
 * Claims testnet $FLOP via the official HTTPS Faucet API or its verified
 * Technocore Faucet Bot, enforcing strict anti-sybil / no-blind-retry guards.
 */
export async function claimDailyFaucet(
  seedHex: string,
  config: FlopTestnetEnvConfig,
  options: { viaTechnocoreBot?: boolean; skipNetworkMatch?: boolean } = {}
): Promise<{ claimed: boolean; outcome: string; txHash?: string; reason?: string }> {
  if (!config.faucetUrl) {
    return { claimed: false, outcome: 'unavailable', reason: 'No FLOP_FAUCET_URL configured' };
  }

  const identity = await deriveAgentSubstrateIdentity(seedHex, config.substrateUri);
  const state = loadLocalAgentState(config.stateFilePath);

  if (state.lastFaucetAttemptAt && state.network === config.network) {
    const elapsed = Date.now() - Date.parse(state.lastFaucetAttemptAt);
    if (Number.isFinite(elapsed) && elapsed < FAU_COOLDOWN_MS) {
      if (state.lastFaucetOutcome === 'unknown') {
        return {
          claimed: false,
          outcome: 'unknown_pending_reconcile',
          reason: 'Prior faucet request outcome was unknown; reconcile balance instead of retrying blindly.',
        };
      }
      if (state.lastFaucetOutcome === 'accepted') {
        const hrsLeft = ((FAU_COOLDOWN_MS - elapsed) / 3_600_000).toFixed(1);
        return {
          claimed: false,
          outcome: 'cooldown',
          reason: `Already claimed within 24h (${hrsLeft}h remaining before next daily faucet claim).`,
        };
      }
    }
  }

  const chainCheck = await fetchFaucetChainMetadata(config.faucetUrl);
  if (!chainCheck.ok || !chainCheck.data) {
    return {
      claimed: false,
      outcome: 'unavailable',
      reason: `Faucet /chain unreachable: ${chainCheck.error ?? `HTTP ${chainCheck.status}`}`,
    };
  }

  if (!options.skipNetworkMatch && chainCheck.data.network !== config.network) {
    return {
      claimed: false,
      outcome: 'network_mismatch',
      reason: `Refusing claim: expected network=${config.network}, faucet /chain reported ${chainCheck.data.network}`,
    };
  }

  if (options.viaTechnocoreBot && chainCheck.data.technocoreBot) {
    const bot = chainCheck.data.technocoreBot;
    const preHealth = await getRoomHealth(bot.room, config.technocoreUrl);
    const lastSeq = preHealth.messages.at(-1)?.seq ?? 0;
    const nonce = Date.now();
    const cmdText = `!faucet request ${identity.ss58Address} ${nonce}`;
    const postRes = await postSignedTechnocoreMessage(seedHex, bot.room, nonce, cmdText, config.technocoreUrl);

    if (postRes.status !== 200) {
      return {
        claimed: false,
        outcome: 'refused',
        reason: `Technocore faucet room post failed (HTTP ${postRes.status}): ${postRes.text}`,
      };
    }

    // Long-poll once for the bot's signed challenge reply (`patterns.md` §8)
    const pollRes = await fetch(
      `${config.technocoreUrl}/r/${bot.room}?since=${lastSeq}&wait=10&format=json`,
      { headers: { 'User-Agent': 'TechnocoreAgentBot/1.0' }, signal: AbortSignal.timeout(15_000) }
    );
    if (!pollRes.ok) {
      return { claimed: false, outcome: 'unknown', reason: `Technocore poll failed: HTTP ${pollRes.status}` };
    }
    const pollJson = (await pollRes.json()) as {
      messages?: Array<{ seq: number; from?: string; sender?: string; text?: string; sig?: string; nonce?: number }>;
    };
    const botReply = (pollJson.messages ?? []).find((m) => {
      const sender = m.from || m.sender || '';
      const text = m.text || '';
      if (sender !== bot.did || typeof m.sig !== 'string' || m.nonce === undefined) return false;
      if (!verifyRoomMessage(bot.did, bot.room, m.nonce, text, m.sig)) return false;
      return text.includes(`fund|${identity.ss58Address}|${nonce}`);
    });

    if (!botReply?.text) {
      state.lastFaucetAttemptAt = new Date().toISOString();
      state.lastFaucetOutcome = 'unknown';
      state.address = identity.ss58Address;
      state.network = config.network;
      saveLocalAgentState(config.stateFilePath, state);
      return {
        claimed: false,
        outcome: 'unknown',
        reason: 'Did not receive a verified signed challenge from the official faucet bot within 10s.',
      };
    }

    const challenge = `fund|${identity.ss58Address}|${nonce}`;
    const signedChallenge = signChallengeBytes(seedHex, challenge);
    const faucetBase = config.faucetUrl.replace(/\/+$/, '');
    const fundUrl = `${faucetBase}/faucet/fund/${identity.ss58Address}/${nonce}/${signedChallenge.sigHex}`;
    const claimRes = await fetch(fundUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    const claimBody = await claimRes.text();
    state.lastFaucetAttemptAt = new Date().toISOString();
    state.address = identity.ss58Address;
    state.network = config.network;
    state.lastFaucetOutcome = claimRes.ok ? 'accepted' : claimRes.status >= 500 ? 'unknown' : 'refused';
    saveLocalAgentState(config.stateFilePath, state);
    return {
      claimed: claimRes.ok,
      outcome: state.lastFaucetOutcome,
      reason: claimBody.slice(0, 300),
    };
  }

  // Standard SDK single-shot POST /fund (never retries blindly)
  const res = await requestFaucetFunding(identity.ss58Address, {
    network: config.network,
    endpoint: config.faucetUrl,
  });

  state.address = identity.ss58Address;
  state.network = config.network;
  state.lastFaucetAttemptAt = res.timestamp;
  state.lastFaucetOutcome = res.outcome ?? (res.success ? 'accepted' : 'unknown');
  if (res.txHash) state.lastFaucetTxHash = res.txHash;
  saveLocalAgentState(config.stateFilePath, state);

  return {
    claimed: res.success,
    outcome: state.lastFaucetOutcome,
    txHash: res.txHash,
    reason: res.error ?? res.reason,
  };
}

/**
 * Executes a genuine multi-turn organic inference session and settles spend
 * through either an on-chain compute channel (`buyInferenceSession` / HTLC)
 * or the correlated REST gateway (`FlopClient.task()`).
 */
export async function spendTestnetCompute(
  seedHex: string,
  config: FlopTestnetEnvConfig,
  options: { escrowFlop?: number; modelId?: string } = {}
): Promise<{ spent: boolean; rail: string; details: Record<string, unknown> }> {
  const identity = await deriveAgentSubstrateIdentity(seedHex, config.substrateUri);
  const models: FlopModelInfo[] = await getLiveFlopModels(config.gatewayUrl);
  const candidateModel =
    (options.modelId ? models.find((m) => m.id === options.modelId) : undefined) ||
    models.find((m) => m.activeMinersCount > 0) ||
    models[0];

  const taskSpec = buildOrganicAgentTask();
  const state = loadLocalAgentState(config.stateFilePath);

  // Path 1: On-chain direct compute-channel session (`pallet_compute_channel`)
  if (config.minerUrl) {
    const chainClient = await FlopChainClient.createWithKeypair(config.rpcUrl, identity.pair);
    try {
      const escrowFlop = options.escrowFlop ?? 5;
      const acct = await chainClient.getAccountInfo(identity.ss58Address);
      const requiredRaw = BigInt(escrowFlop + 1) * 10n ** BigInt(FLOP_DECIMALS);
      if (acct.free < requiredRaw) {
        return {
          spent: false,
          rail: 'direct-compute-channel',
          details: {
            reason: `Insufficient balance (${formatFlop(acct.free)} FLOP free; need >= ${escrowFlop + 1} FLOP with fee buffer)`,
          },
        };
      }

      const sessionResult = await chainClient.buyInferenceSession({
        minerUrl: config.minerUrl,
        prompt: taskSpec.turns[0],
        escrowFlop,
        onPrepared: async (intent) => {
          const nextState = loadLocalAgentState(config.stateFilePath);
          nextState.pendingPurchaseIntents = nextState.pendingPurchaseIntents ?? {};
          nextState.pendingPurchaseIntents[intent.channelId] = intent;
          saveLocalAgentState(config.stateFilePath, nextState);
        },
      });

      state.lastSpendAt = new Date().toISOString();
      state.completedSessions = state.completedSessions ?? [];
      state.completedSessions.push({
        timestamp: state.lastSpendAt,
        mode: 'direct-channel',
        model: candidateModel?.id ?? 'direct-miner',
        channelId: sessionResult.channelId,
        gnUsed: sessionResult.gnUsed.toString(),
      });
      saveLocalAgentState(config.stateFilePath, state);

      return {
        spent: true,
        rail: 'direct-compute-channel',
        details: {
          channelId: sessionResult.channelId,
          gnUsed: sessionResult.gnUsed.toString(),
          turnsVerified: sessionResult.turnsVerified,
          challengeEnd: sessionResult.challengeEnd.toString(),
          status: sessionResult.status,
        },
      };
    } finally {
      await chainClient.disconnect();
    }
  }

  // Path 2: Gateway correlated multi-turn task (`@flop-labs/client` loaded via native ESM import)
  if (config.apiKey && candidateModel) {
    const baseURL = `${config.gatewayUrl.replace(/\/+$/, '')}/v1`;
    const loadGatewayModule = new Function(
      'specifier',
      'return import(specifier)'
    ) as (specifier: string) => Promise<typeof import('@flop-labs/client')>;
    const { FlopClient: FlopGatewayClient } = await loadGatewayModule('@flop-labs/client');
    const gwClient = new FlopGatewayClient({ baseURL, apiKey: config.apiKey });
    const task = gwClient.task(taskSpec.id);

    const turn1 = await task.createChatCompletion(
      {
        model: candidateModel.id,
        messages: [
          { role: 'system', content: taskSpec.systemPrompt },
          { role: 'user', content: taskSpec.turns[0] },
        ],
        max_tokens: 256,
        stream: false,
      },
      {
        idempotencyKey: `t1-${taskSpec.id}-${crypto.randomUUID()}`,
        signal: AbortSignal.timeout(45_000),
      }
    );

    const assistantReply1 = turn1.choices[0]?.message?.content ?? '';
    const turn2 = await task.createChatCompletion(
      {
        model: candidateModel.id,
        messages: [
          { role: 'system', content: taskSpec.systemPrompt },
          { role: 'user', content: taskSpec.turns[0] },
          { role: 'assistant', content: assistantReply1 },
          { role: 'user', content: taskSpec.turns[1] },
        ],
        max_tokens: 256,
        stream: false,
      },
      {
        idempotencyKey: `t2-${taskSpec.id}-${crypto.randomUUID()}`,
        signal: AbortSignal.timeout(45_000),
      }
    );

    state.lastSpendAt = new Date().toISOString();
    state.completedSessions = state.completedSessions ?? [];
    state.completedSessions.push({
      timestamp: state.lastSpendAt,
      mode: 'gateway',
      model: candidateModel.id,
      correlationId: task.correlationId,
      txOrReceiptId: turn2.id,
    });
    saveLocalAgentState(config.stateFilePath, state);

    return {
      spent: true,
      rail: 'gateway',
      details: {
        model: candidateModel.id,
        correlationId: task.correlationId,
        turn1Id: turn1.id,
        turn2Id: turn2.id,
        turn1Usage: turn1.usage,
        turn2Usage: turn2.usage,
      },
    };
  }

  // Path 3: On-chain HTLC buyVerifiedInference when neither direct miner URL nor gateway API key is configured
  if (candidateModel) {
    const chainClient = await FlopChainClient.createWithKeypair(config.rpcUrl, identity.pair);
    try {
      const maxFlop = options.escrowFlop ?? 5;
      const acct = await chainClient.getAccountInfo(identity.ss58Address);
      const requiredRaw = BigInt(maxFlop + 1) * 10n ** BigInt(FLOP_DECIMALS);
      if (acct.free < requiredRaw) {
        return {
          spent: false,
          rail: 'onchain-htlc',
          details: {
            reason: `Insufficient balance (${formatFlop(acct.free)} FLOP free; need >= ${maxFlop + 1} FLOP)`,
          },
        };
      }

      const receipt: InferenceReceipt = await chainClient.buyVerifiedInference({
        model: candidateModel.id,
        prompt: `${taskSpec.systemPrompt}\n\n${taskSpec.turns[0]}`,
        maxFlop,
      });

      return {
        spent: true,
        rail: 'onchain-htlc',
        details: {
          model: receipt.model,
          gnUsed: receipt.gnUsed,
          blockNumber: receipt.blockNumber,
          txHash: receipt.txHash,
          hashLock: receipt.hashLock,
        },
      };
    } finally {
      await chainClient.disconnect();
    }
  }

  return {
    spent: false,
    rail: 'none',
    details: {
      reason: 'No active gateway models, FLOP_MINER_URL, or FLOP_API_KEY available yet.',
    },
  };
}
