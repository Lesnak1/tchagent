import { getAgentFlopStatus, FLOP_DEVNET_CONFIG } from '../lib/flop';

async function main() {
  console.log('================================================================');
  console.log('FLOP NETWORK DEVNET & AGENT STATUS HARNESS');
  console.log('================================================================');
  console.log(`Target Network : ${FLOP_DEVNET_CONFIG.network.toUpperCase()}`);
  console.log(`RPC Endpoint   : ${FLOP_DEVNET_CONFIG.rpcUrl}`);
  console.log(`Gateway URL    : ${FLOP_DEVNET_CONFIG.gatewayUrl}`);
  console.log(`Genesis Hash   : ${FLOP_DEVNET_CONFIG.genesisHash}`);
  console.log(`Spec Version   : ${FLOP_DEVNET_CONFIG.specVersion}`);
  console.log('----------------------------------------------------------------');

  const seed = process.env.AGENT_SEED;
  const room = process.env.ROOM_NAME || 'd-lesnak1';

  const status = await getAgentFlopStatus(seed, room);

  console.log(`Agent DID      : ${status.agentDid}`);
  console.log(`Owned Room     : ${status.room}`);
  console.log(`Gateway Status : ${status.devnetReachable ? '✅ ONLINE & REACHABLE' : '❌ UNREACHABLE'}`);
  console.log(`Active Models  : ${status.models.length}`);

  for (const m of status.models) {
    console.log(`  - Model: ${m.name} (${m.id})`);
    console.log(`    Context Window: ${m.contextLength} tokens`);
    console.log(`    Pricing: ${m.promptPrice} prompt / ${m.completionPrice} completion`);
    console.log(`    Active Miner Nodes: ${m.activeMinersCount}`);
    if (m.minerAddresses.length > 0) {
      console.log(`    Sample Miners: ${m.minerAddresses.slice(0, 3).join(', ')}...`);
    }
  }

  console.log('----------------------------------------------------------------');
  console.log('YELLOW PAPER §8.2 & TESTNET (ERA-T) AIRDROP RULES:');
  console.log(`  - Genesis Pool      : ${status.yellowPaperRule.poolSize}`);
  console.log(`  - Scoring Metric    : ${status.yellowPaperRule.scoringMetric}`);
  console.log(`  - Spend-to-Unlock   : ${status.yellowPaperRule.spendToUnlockRatio}`);
  console.log(`  - Anti-Fraud Policy : ${status.yellowPaperRule.antiFraudRule}`);
  console.log('================================================================');
}

main().catch((err) => {
  console.error('Fatal harness error:', err);
  process.exit(1);
});

