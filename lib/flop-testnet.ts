import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {
  D10_FAUCET_GENESIS_HASH,
  FLOP_DECIMALS,
  FLOP_SS58_FORMAT,
  FlopClient as FlopChainClient,
  type FlopNetwork,
  type InferencePurchaseIntent,
  type InferenceReceipt,
  claimTestnetAgentFunds,
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
  lastFaucetNonce?: string;
  lastFaucetTransferStatus?: string;
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

export interface FaucetLimitsMetadata {
  network: string;
  faucet?: {
    status?: string;
    signer?: string;
    minBalanceFlop?: string;
    dailyCap?: {
      limitFlop?: string;
      usedFlop?: string;
      remainingFlop?: string;
    };
    pendingGrants?: number;
    agent?: {
      grantFlop?: number;
      claimPath?: string;
      rolling24HourCapFlop?: number;
      cooldownSeconds?: number;
      rolloverRequiresSpend?: boolean;
    };
  };
}

export interface FaucetHealthMetadata {
  status?: string;
  connected?: boolean;
  live?: boolean;
  ready?: boolean;
  dependencies?: {
    signer?: { ok?: boolean };
    indexer?: { ok?: boolean; details?: { lagBlocks?: number } };
    funding?: { ok?: boolean };
    signing?: { held?: boolean; reason?: string | null };
  };
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

export const FLOP_TESTNET_GENESIS_HASH = D10_FAUCET_GENESIS_HASH;
export const FLOP_TESTNET_EXPLORER_URL = 'https://testnet.flopscan.io';

export interface FlopscanStats {
  latestBlockNumber: number;
  registeredMiners: number;
  activeValidators: number;
  activeAgents: number;
  totalAccounts: number;
  totalHTLCs: number;
  proofs24h: number;
  finality?: {
    finalizedBlock?: number;
    state?: string;
  };
  consensus?: {
    state?: string;
    peers?: number;
  };
}

export interface GatewayHealthMetadata {
  status?: string;
  version?: string;
  image?: { version?: string; revision?: string };
  connected?: boolean;
  syncing?: boolean;
  network?: {
    network?: string;
    status?: string;
    expected_genesis_hash?: string;
    observed_genesis_hash?: string;
  };
  dependencies?: {
    backing_service?: { ok?: boolean };
    catalog?: { ok?: boolean };
    settlement?: { ok?: boolean };
    storage?: { ok?: boolean };
  };
}

export interface FlopscanInferenceSpend {
  totalSpentRaw: string;
  settledChannels: number;
  uniqueAgents: number;
  topSpenders?: Array<{ agent: string; spent: string }>;
}

const FAU_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function getFlopNetworkConfig(networkOverride?: FlopNetwork): FlopTestnetEnvConfig {
  const rawNet = (networkOverride || process.env.FLOP_NETWORK || 'testnet').toLowerCase();
  const network: FlopNetwork = isFlopNetwork(rawNet) ? rawNet : 'testnet';
  const profile = getFlopNetworkProfile(network);

  const explorerDefault =
    network === 'devnet' ? 'https://explorer.devnet.flop.network' : FLOP_TESTNET_EXPLORER_URL;

  return {
    network,
    rpcUrl: (process.env.FLOP_RPC_URL || profile.rpc).trim(),
    gatewayUrl: (process.env.FLOP_GATEWAY_URL || profile.gateway || '').trim(),
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

export async function fetchFaucetLimits(
  faucetUrl: string
): Promise<{ ok: boolean; status: number; data?: FaucetLimitsMetadata; error?: string }> {
  const base = faucetUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/limits`, {
      headers: { Accept: 'application/json', 'User-Agent': 'TechnocoreAgentBot/1.0' },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as FaucetLimitsMetadata;
    return { ok: true, status: res.status, data };
  } catch (err: unknown) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function fetchFaucetHealth(
  faucetUrl: string
): Promise<{ ok: boolean; status: number; data?: FaucetHealthMetadata; error?: string }> {
  const base = faucetUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/health`, {
      headers: { Accept: 'application/json', 'User-Agent': 'TechnocoreAgentBot/1.0' },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    const text = await res.text();
    let data: FaucetHealthMetadata | undefined;
    try {
      data = JSON.parse(text) as FaucetHealthMetadata;
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      return { ok: false, status: res.status, data, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, data };
  } catch (err: unknown) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function fetchFlopscanStats(
  explorerUrl: string
): Promise<{ ok: boolean; status: number; data?: FlopscanStats; error?: string }> {
  const base = explorerUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/stats`, {
      headers: { Accept: 'application/json', 'User-Agent': 'TechnocoreAgentBot/1.0' },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as FlopscanStats;
    return { ok: true, status: res.status, data };
  } catch (err: unknown) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function fetchFlopscanInferenceSpend(
  explorerUrl: string
): Promise<{ ok: boolean; status: number; data?: FlopscanInferenceSpend; error?: string }> {
  const base = explorerUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/inference-spend?limit=5`, {
      headers: { Accept: 'application/json', 'User-Agent': 'TechnocoreAgentBot/1.0' },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as FlopscanInferenceSpend;
    return { ok: true, status: res.status, data };
  } catch (err: unknown) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function fetchGatewayHealth(
  gatewayUrl: string
): Promise<{ ok: boolean; status: number; data?: GatewayHealthMetadata; error?: string }> {
  const base = gatewayUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/health`, {
      headers: { Accept: 'application/json', 'User-Agent': 'TechnocoreAgentBot/1.0' },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as GatewayHealthMetadata;
    return { ok: true, status: res.status, data };
  } catch (err: unknown) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function httpGetNoSecFetch(
  urlStr: string,
  timeoutMs = 20_000
): Promise<{ ok: boolean; status: number; body: string; refusalReason?: string }> {
  return new Promise((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlStr);
    } catch (err) {
      reject(err);
      return;
    }

    const transport = parsedUrl.protocol === 'http:' ? http : https;
    const req = transport.request(
      parsedUrl,
      {
        method: 'GET',
        headers: {
          Accept: 'text/plain, application/json',
          'User-Agent': 'TechnocoreAgentBot/1.0',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString('utf8');
          const rawReason = res.headers['x-flop-refusal-reason'];
          const refusalReason = Array.isArray(rawReason) ? rawReason[0] : rawReason;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            body,
            refusalReason: refusalReason?.trim() || undefined,
          });
        });
        res.on('error', reject);
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
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
  console.log(`Configured Gateway: ${config.gatewayUrl || 'none'}`);
  console.log(`Configured Faucet : ${config.faucetUrl ?? 'none'}`);
  console.log(`ConfiguredExplorer: ${config.explorerUrl}`);
  if (config.network === 'testnet') {
    console.log(`Pinned Genesis    : ${FLOP_TESTNET_GENESIS_HASH}`);
  }
  console.log(`Local State File  : ${config.stateFilePath}`);
  console.log(`Last Faucet Claim : ${state.lastFaucetAttemptAt ?? 'none'} (${state.lastFaucetOutcome ?? 'n/a'})`);
  console.log('----------------------------------------------------------------');

  const [scanStats, spendStats] = await Promise.all([
    fetchFlopscanStats(config.explorerUrl),
    fetchFlopscanInferenceSpend(config.explorerUrl),
  ]);
  if (scanStats.ok && scanStats.data) {
    const s = scanStats.data;
    const finBlock = s.finality?.finalizedBlock ?? 'n/a';
    const finState = s.finality?.state ?? 'n/a';
    const consState = s.consensus?.state ?? 'n/a';
    const peers = s.consensus?.peers ?? 'n/a';
    console.log(
      `FLOPScan Chain    : block #${s.latestBlockNumber} (finalized #${finBlock}, ${finState}) | consensus=${consState} peers=${peers}`
    );
    console.log(
      `FLOPScan Network  : validators=${s.activeValidators}, miners=${s.registeredMiners}, agents=${s.activeAgents}, accounts=${s.totalAccounts}, htlcs=${s.totalHTLCs}, proofs24h=${s.proofs24h}`
    );
  } else {
    console.log(`FLOPScan Chain    : UNREACHABLE (${scanStats.error ?? `HTTP ${scanStats.status}`})`);
  }
  if (spendStats.ok && spendStats.data) {
    const sp = spendStats.data;
    const spentFlop = formatFlop(BigInt(sp.totalSpentRaw || '0'));
    console.log(
      `FLOPScan Spend    : settledChannels=${sp.settledChannels}, uniqueAgents=${sp.uniqueAgents}, totalSpent=${spentFlop} FLOP`
    );
  }

  let faucetMatchesTestnet = false;
  if (config.faucetUrl) {
    const [chainMeta, limitsRes, healthRes] = await Promise.all([
      fetchFaucetChainMetadata(config.faucetUrl),
      fetchFaucetLimits(config.faucetUrl),
      fetchFaucetHealth(config.faucetUrl),
    ]);
    if (chainMeta.ok && chainMeta.data) {
      const genesisOk =
        config.network !== 'testnet' ||
        chainMeta.data.genesisHash.toLowerCase() === FLOP_TESTNET_GENESIS_HASH;
      faucetMatchesTestnet = genesisOk;
      const genesisTag =
        config.network === 'testnet'
          ? genesisOk
            ? '[GENESIS MATCH]'
            : '[GENESIS MISMATCH]'
          : '';
      console.log(
        `Faucet /chain     : REACHABLE (${chainMeta.data.network}, genesis ${chainMeta.data.genesisHash.slice(0, 14)}...) ${genesisTag}`.trim()
      );
      if (chainMeta.data.technocoreBot) {
        console.log(`Faucet Bot        : room=/r/${chainMeta.data.technocoreBot.room} did=${chainMeta.data.technocoreBot.did}`);
      }
    } else {
      console.log(`Faucet /chain     : NOT LIVE YET (${chainMeta.error ?? `HTTP ${chainMeta.status}`})`);
    }
    if (healthRes.ok && healthRes.data) {
      const d = healthRes.data;
      const signerOk = d.dependencies?.signer?.ok ? 'ok' : 'err';
      const indexerOk = d.dependencies?.indexer?.ok ? 'ok' : 'err';
      const lag = d.dependencies?.indexer?.details?.lagBlocks ?? 'n/a';
      console.log(
        `Faucet /health    : ${d.ready ? 'READY' : 'NOT READY'} (live=${String(Boolean(d.live))}, signer=${signerOk}, indexer=${indexerOk} lag=${lag})`
      );
    } else {
      console.log(
        `Faucet /health    : NOT READY (${healthRes.error ?? `HTTP ${healthRes.status}`})`
      );
    }
    if (limitsRes.ok && limitsRes.data?.faucet) {
      const f = limitsRes.data.faucet;
      if (f.agent) {
        console.log(
          `Faucet Agent Tier : grant=${f.agent.grantFlop ?? 'n/a'} FLOP, path=${f.agent.claimPath ?? 'n/a'}, rolloverRequiresSpend=${String(f.agent.rolloverRequiresSpend ?? 'n/a')}`
        );
      }
      if (f.dailyCap) {
        console.log(
          `Faucet Daily Cap  : remaining=${f.dailyCap.remainingFlop ?? 'n/a'} / ${f.dailyCap.limitFlop ?? 'n/a'} FLOP (pending=${f.pendingGrants ?? 0})`
        );
      }
    }
  }

  const [gwModels, gwHealth] = config.gatewayUrl
    ? await Promise.all([
        getLiveFlopModels(config.gatewayUrl),
        fetchGatewayHealth(config.gatewayUrl),
      ])
    : [
        [] as FlopModelInfo[],
        { ok: false, status: 0 } as {
          ok: boolean;
          status: number;
          data?: GatewayHealthMetadata;
          error?: string;
        },
      ];

  if (gwHealth.ok && gwHealth.data) {
    const h = gwHealth.data;
    const expected = h.network?.expected_genesis_hash?.toLowerCase();
    const observed = h.network?.observed_genesis_hash?.toLowerCase();
    const genesisStatus =
      expected && observed
        ? expected === observed &&
          (config.network !== 'testnet' || observed === FLOP_TESTNET_GENESIS_HASH)
          ? 'MATCH'
          : 'MISMATCH'
        : 'n/a';
    const settleOk = h.dependencies?.settlement?.ok ? 'ok' : 'err';
    console.log(
      `Gateway /health   : ${h.status === 'ok' ? 'OK' : String(h.status ?? 'UNKNOWN')} (v${h.image?.version ?? h.version ?? 'n/a'}, genesis=${genesisStatus}, settlement=${settleOk})`
    );
  } else if (config.gatewayUrl) {
    console.log(
      `Gateway /health   : UNREACHABLE (${gwHealth.error ?? `HTTP ${gwHealth.status}`})`
    );
  }
  const modelIds = gwModels.map((m) => m.id).join(', ');
  console.log(
    `Gateway /v1/models: ${gwModels.length > 0 ? `ONLINE (${gwModels.length} models: ${modelIds})` : 'NOT LIVE YET / UNREACHABLE'}`
  );

  if (options.allowDevnetProbe && config.network !== 'devnet') {
    const devnet = getFlopNetworkProfile('devnet');
    const devChain = devnet.faucet ? await fetchFaucetChainMetadata(devnet.faucet) : { ok: false, status: 0 };
    const devModels = devnet.gateway ? await getLiveFlopModels(devnet.gateway) : [];
    console.log('----------------------------------------------------------------');
    console.log(`Devnet Baseline   : faucet=${devChain.ok ? `OK (${devChain.data?.technocoreBot?.room ?? 'no-bot'})` : 'ERR'}, models=${devModels.length}`);
  }

  // Check on-chain RPC connectivity & balance when live
  try {
    const chainClient = await FlopChainClient.createWithKeypair(config.rpcUrl, identity.pair, {
      expectedGenesisHash: config.network === 'testnet' ? D10_FAUCET_GENESIS_HASH : undefined,
    });
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
  const minersCount = scanStats.data?.registeredMiners ?? 0;
  const agentsCount = scanStats.data?.activeAgents ?? 0;
  if (config.network === 'testnet' && !faucetMatchesTestnet) {
    console.log(
      `Readiness Summary : Testnet faucet not live/matched yet (miners=${minersCount}, agents=${agentsCount}, gatewayModels=${gwModels.length}).`
    );
    console.log('Hold faucet/spend until Faucet /chain reports [GENESIS MATCH].');
  } else if (config.network === 'testnet' && (gwModels.length === 0 || minersCount === 0)) {
    console.log(
      `Readiness Summary : Testnet faucet is LIVE ([GENESIS MATCH]), unscored opening (miners=${minersCount}, agents=${agentsCount}, gatewayModels=${gwModels.length}).`
    );
    console.log('Safe for single-shot: npm run flop-testnet:faucet | Hold --spend until miners & voucher start block activate.');
  } else if (config.network === 'testnet') {
    console.log(
      `Readiness Summary : Testnet Gateway & Miners LIVE (miners=${minersCount}, models=${gwModels.length}, agents=${agentsCount}).`
    );
    console.log('Balance ready; wait for announced scored voucher start block before full daily spend (unscored opening earns 0).');
  } else {
    console.log(
      `Readiness Summary : Network online (miners=${minersCount}, agents=${agentsCount}, models=${gwModels.length}).`
    );
    console.log('Ready to run: npm run flop-testnet:run');
  }
  console.log('================================================================');
}

/**
 * Claims testnet $FLOP via the official HTTPS Faucet API or its verified
 * Technocore Faucet Bot, enforcing strict anti-sybil / no-blind-retry guards.
 */
export async function claimDailyFaucet(
  seedHex: string,
  config: FlopTestnetEnvConfig,
  options: {
    viaTechnocoreBot?: boolean;
    skipNetworkMatch?: boolean;
    reconcileUnknown?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<{
  claimed: boolean;
  outcome: string;
  txHash?: string;
  reason?: string;
  nonce?: string;
  transferStatus?: string;
}> {
  if (!config.faucetUrl) {
    return { claimed: false, outcome: 'unavailable', reason: 'No FLOP_FAUCET_URL configured' };
  }

  const identity = await deriveAgentSubstrateIdentity(seedHex, config.substrateUri);
  const state = loadLocalAgentState(config.stateFilePath);

  let reconcileNonce: string | undefined;
  if (state.lastFaucetAttemptAt && state.network === config.network) {
    const elapsed = Date.now() - Date.parse(state.lastFaucetAttemptAt);
    if (state.lastFaucetOutcome === 'unknown') {
      if (!options.reconcileUnknown) {
        return {
          claimed: false,
          outcome: 'unknown_pending_reconcile',
          nonce: state.lastFaucetNonce,
          reason:
            'Prior faucet request outcome was unknown; run with --reconcile to verify balance and repeat the same nonce safely.',
        };
      }

      const chainClient = await FlopChainClient.createWithKeypair(config.rpcUrl, identity.pair, {
        expectedGenesisHash: config.network === 'testnet' ? D10_FAUCET_GENESIS_HASH : undefined,
      });
      try {
        const acct = await chainClient.getAccountInfo(identity.ss58Address);
        if (acct.free > 0n) {
          state.lastFaucetOutcome = 'accepted';
          saveLocalAgentState(config.stateFilePath, state);
          return {
            claimed: true,
            outcome: 'reconciled_onchain',
            nonce: state.lastFaucetNonce,
            reason: `Balance already credited on-chain (${formatFlop(acct.free)} FLOP free)`,
          };
        }
      } finally {
        await chainClient.disconnect();
      }

      if (state.lastFaucetNonce) {
        reconcileNonce = state.lastFaucetNonce;
      }
    } else if (
      state.lastFaucetOutcome === 'accepted' &&
      Number.isFinite(elapsed) &&
      elapsed < FAU_COOLDOWN_MS
    ) {
      const hrsLeft = ((FAU_COOLDOWN_MS - elapsed) / 3_600_000).toFixed(1);
      return {
        claimed: false,
        outcome: 'cooldown',
        reason: `Already claimed within 24h (${hrsLeft}h remaining before next daily faucet claim).`,
      };
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

  if (
    !options.skipNetworkMatch &&
    config.network === 'testnet' &&
    chainCheck.data.genesisHash?.toLowerCase() !== FLOP_TESTNET_GENESIS_HASH
  ) {
    return {
      claimed: false,
      outcome: 'genesis_mismatch',
      reason: `Refusing claim: expected Testnet genesis ${FLOP_TESTNET_GENESIS_HASH}, faucet /chain reported ${chainCheck.data.genesisHash}`,
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

    // Long-poll once for the bot's signed reply (`patterns.md` §8)
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
      return (
        text.includes(`fund|${identity.ss58Address}|${nonce}`) ||
        text.includes(identity.ss58Address) ||
        text.includes(String(nonce))
      );
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
        reason: 'Did not receive a verified signed reply from the official faucet bot within 10s.',
      };
    }

    const challenge = `fund|${identity.ss58Address}|${nonce}`;
    if (!botReply.text.includes(challenge)) {
      const txMatch = botReply.text.match(/\b(0x[0-9a-fA-F]{64})\b/);
      state.lastFaucetAttemptAt = new Date().toISOString();
      state.address = identity.ss58Address;
      state.network = config.network;
      if (txMatch && !botReply.text.includes('Unsigned challenge:')) {
        state.lastFaucetOutcome = 'accepted';
        state.lastFaucetTxHash = txMatch[1];
        saveLocalAgentState(config.stateFilePath, state);
        return {
          claimed: true,
          outcome: 'accepted',
          txHash: txMatch[1],
          reason: botReply.text.slice(0, 300),
        };
      }
      state.lastFaucetOutcome = 'refused';
      saveLocalAgentState(config.stateFilePath, state);
      return {
        claimed: false,
        outcome: 'refused',
        reason: botReply.text.slice(0, 300),
      };
    }

    const signedChallenge = signChallengeBytes(seedHex, challenge);
    const urlOriginMatch = botReply.text.match(/https:\/\/[a-z0-9.-]+(?=\/faucet\/fund\/)/i);
    const faucetBase = (urlOriginMatch ? urlOriginMatch[0] : config.faucetUrl).replace(/\/+$/, '');
    const fundUrl = `${faucetBase}/faucet/fund/${identity.ss58Address}/${nonce}/${signedChallenge.sigHex}`;
    const claimRes = await httpGetNoSecFetch(fundUrl, 20_000);
    state.lastFaucetAttemptAt = new Date().toISOString();
    state.address = identity.ss58Address;
    state.network = config.network;
    state.lastFaucetOutcome = claimRes.ok ? 'accepted' : claimRes.status >= 500 || claimRes.status === 0 ? 'unknown' : 'refused';
    const txMatch = claimRes.body.match(/\b(0x[0-9a-fA-F]{64})\b/);
    if (claimRes.ok && txMatch) {
      state.lastFaucetTxHash = txMatch[1];
    }
    saveLocalAgentState(config.stateFilePath, state);
    return {
      claimed: claimRes.ok,
      outcome: state.lastFaucetOutcome,
      txHash: claimRes.ok && txMatch ? txMatch[1] : undefined,
      reason: claimRes.refusalReason
        ? `${claimRes.refusalReason}: ${claimRes.body.slice(0, 260)}`
        : claimRes.body.slice(0, 300),
    };
  }

  if (config.network === 'testnet') {
    if (!reconcileNonce) {
      const healthRes = await fetchFaucetHealth(config.faucetUrl);
      if (!healthRes.ok || !healthRes.data?.ready) {
        const signerOk = healthRes.data?.dependencies?.signer?.ok;
        const indexerOk = healthRes.data?.dependencies?.indexer?.ok;
        return {
          claimed: false,
          outcome: 'unavailable',
          reason: `Faucet /health not ready (${healthRes.error ?? `HTTP ${healthRes.status}`}, ready=${String(Boolean(healthRes.data?.ready))}, signer=${String(signerOk)}, indexer=${String(indexerOk)}). Aborted before signing.`,
        };
      }
    }

    const res = await claimTestnetAgentFunds(identity.ss58Address, {
      endpoint: config.faucetUrl,
      nonce: reconcileNonce,
      timeout: options.timeoutMs ?? 90_000,
      sign: (message: Uint8Array) => identity.pair.sign(message),
    });

    state.address = identity.ss58Address;
    state.network = config.network;
    state.lastFaucetAttemptAt = res.timestamp;
    state.lastFaucetOutcome = res.outcome ?? (res.success ? 'accepted' : 'unknown');
    state.lastFaucetNonce = res.nonce;
    if (res.txHash) state.lastFaucetTxHash = res.txHash;
    if (res.transferStatus) state.lastFaucetTransferStatus = res.transferStatus;
    saveLocalAgentState(config.stateFilePath, state);

    return {
      claimed: res.success,
      outcome: state.lastFaucetOutcome,
      txHash: res.txHash,
      reason: res.error ?? res.reason,
      nonce: res.nonce,
      transferStatus: res.transferStatus,
    };
  }

  // Standard SDK single-shot POST /fund (never retries blindly; devnet/local)
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
  const models: FlopModelInfo[] = config.gatewayUrl ? await getLiveFlopModels(config.gatewayUrl) : [];
  const candidateModel =
    (options.modelId ? models.find((m) => m.id === options.modelId) : undefined) ||
    models.find((m) => m.activeMinersCount > 0) ||
    models[0];

  const taskSpec = buildOrganicAgentTask();
  const state = loadLocalAgentState(config.stateFilePath);

  // Path 1: On-chain direct compute-channel session (`pallet_compute_channel`)
  if (config.minerUrl) {
    const chainClient = await FlopChainClient.createWithKeypair(config.rpcUrl, identity.pair, {
      expectedGenesisHash: config.network === 'testnet' ? D10_FAUCET_GENESIS_HASH : undefined,
    });
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
    const chainClient = await FlopChainClient.createWithKeypair(config.rpcUrl, identity.pair, {
      expectedGenesisHash: config.network === 'testnet' ? D10_FAUCET_GENESIS_HASH : undefined,
    });
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
