import { seedToDid } from './crypto';

export const FLOP_DEVNET_CONFIG = {
  network: 'devnet',
  chainName: 'FLOP Devnet',
  rpcUrl: 'wss://rpc.devnet.flop.network',
  gatewayUrl: 'https://api.flop.network',
  faucetUrl: 'https://faucet.flop.network',
  mcpUrl: 'https://mcp.flop.network/mcp',
  explorerUrl: 'https://explorer.devnet.flop.network',
  genesisHash: '0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631',
  specName: 'tzkv-runtime',
  specVersion: 1014003,
};

export interface FlopModelInfo {
  id: string;
  name: string;
  contextLength: number;
  promptPrice: string;
  completionPrice: string;
  activeMinersCount: number;
  minerAddresses: string[];
}

export interface FlopAgentSessionSummary {
  agentDid: string;
  room: string;
  devnetReachable: boolean;
  models: FlopModelInfo[];
  yellowPaperRule: {
    poolSize: string;
    scoringMetric: string;
    spendToUnlockRatio: string;
    antiFraudRule: string;
  };
}

/**
 * Retrieves available inference models directly from the Flop Network gateway.
 */
export async function getLiveFlopModels(baseUrl: string = FLOP_DEVNET_CONFIG.gatewayUrl): Promise<FlopModelInfo[]> {
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/models`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'TechnocoreAgentBot/1.0',
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      console.error(`Failed to fetch models: HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    if (!data || !Array.isArray(data.data)) {
      return [];
    }

    interface RawPriceSource {
      miner_address?: string;
    }
    interface RawGatewayModel {
      id: string;
      name?: string;
      context_length?: number;
      pricing?: { prompt?: string; completion?: string };
      'x-flop'?: { price_sources?: RawPriceSource[] };
    }

    return (data.data as RawGatewayModel[]).map((m) => {
      const priceSources = m['x-flop']?.price_sources || [];
      const minerAddresses = priceSources
        .map((ps) => ps.miner_address)
        .filter((addr): addr is string => Boolean(addr));
      return {
        id: m.id,
        name: m.name || m.id,
        contextLength: m.context_length || 32768,
        promptPrice: m.pricing?.prompt || '0.006',
        completionPrice: m.pricing?.completion || '0.006',
        activeMinersCount: minerAddresses.length,
        minerAddresses,
      };
    });
  } catch (err) {
    console.error('Error contacting Flop Network Gateway:', err);
    return [];
  }
}

/**
 * Generates an audit report and session status for the Technocore Agent.
 */
export async function getAgentFlopStatus(
  seedHex?: string,
  roomName: string = 'd-lesnak1'
): Promise<FlopAgentSessionSummary> {
  let agentDid = 'did:key:z6Mks3ZJxaPg9ReUjxz5EuKPk12AXtq7kiUXqm8jDNSfK78a';
  if (seedHex) {
    try {
      const derived = seedToDid(seedHex);
      agentDid = derived.did;
    } catch {
      // Use fallback agent DID
    }
  }

  const models = await getLiveFlopModels();

  return {
    agentDid,
    room: `/r/${roomName.replace(/^\/r\//, '')}`,
    devnetReachable: models.length > 0,
    models,
    yellowPaperRule: {
      poolSize: '1,200,000,000 $FLOP (6.6% Year-10 supply reserved for Agents)',
      scoringMetric: 'Exclusively settled compute-channel spend on pallet_compute_channel (payable)',
      spendToUnlockRatio: '1 $FLOP unlocked per 3 $FLOP verified inference spend',
      antiFraudRule: 'One participant, one score. Zero circular volume between self-controlled wallets.',
    },
  };
}
