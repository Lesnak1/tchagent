import type { FlopNetwork } from '@flop-labs/sdk';
import {
  claimDailyFaucet,
  getFlopNetworkConfig,
  probeTestnetHealth,
  spendTestnetCompute,
} from '../lib/flop-testnet';

function parseArgs(argv: string[]) {
  const flags = new Set(argv);
  const getValue = (prefix: string): string | undefined => {
    const eqMatch = argv.find((a) => a.startsWith(`${prefix}=`));
    if (eqMatch) return eqMatch.slice(prefix.length + 1);
    const idx = argv.indexOf(prefix);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };

  const mode = flags.has('--doctor')
    ? 'doctor'
    : flags.has('--faucet') || flags.has('--reconcile')
      ? 'faucet'
      : flags.has('--spend')
        ? 'spend'
        : 'run';

  return {
    mode,
    allowDevnetProbe: flags.has('--probe-devnet'),
    viaTechnocoreBot: flags.has('--via-bot'),
    reconcileUnknown: flags.has('--reconcile'),
    networkOverride: getValue('--network') as FlopNetwork | undefined,
    modelId: getValue('--model'),
    escrowFlop: getValue('--escrow') ? Number(getValue('--escrow')) : undefined,
  };
}

async function main() {
  const seedHex = process.env.AGENT_SEED;
  if (!seedHex) {
    console.error('Missing AGENT_SEED environment variable.');
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const config = getFlopNetworkConfig(args.networkOverride);

  if (args.mode === 'doctor') {
    await probeTestnetHealth(seedHex, config, {
      allowDevnetProbe: args.allowDevnetProbe,
    });
    return;
  }

  if (args.mode === 'faucet' || args.mode === 'run') {
    console.log(`[1/2] Requesting daily faucet for ${config.network}...`);
    const faucetRes = await claimDailyFaucet(seedHex, config, {
      viaTechnocoreBot: args.viaTechnocoreBot,
      reconcileUnknown: args.reconcileUnknown,
    });
    console.log('Faucet result:', JSON.stringify(faucetRes, null, 2));
    if (args.mode === 'faucet') {
      if (!faucetRes.claimed && faucetRes.outcome !== 'cooldown') {
        process.exit(1);
      }
      return;
    }
  }

  if (args.mode === 'spend' || args.mode === 'run') {
    console.log(`[2/2] Executing organic inference spend on ${config.network}...`);
    const spendRes = await spendTestnetCompute(seedHex, config, {
      escrowFlop: args.escrowFlop,
      modelId: args.modelId,
    });
    console.log('Spend result:', JSON.stringify(spendRes, null, 2));
    if (!spendRes.spent) {
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('Flop Testnet agent error:', err);
  process.exit(1);
});
