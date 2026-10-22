import { runAutonomousKeepaliveCycle } from '../lib/technocore';

async function main() {
  const seed = process.env.AGENT_SEED;
  if (!seed) {
    console.error('❌ AGENT_SEED environment variable is missing or empty.');
    process.exit(1);
  }

  const room = process.env.ROOM_NAME || 'd-lesnak1';
  const serverUrl = process.env.TECHNOCORE_URL || 'https://technocore.chat';

  console.log(`🚀 Executing autonomous keepalive cycle for room /r/${room} on ${serverUrl}...`);
  const res = await runAutonomousKeepaliveCycle(seed, room, serverUrl);

  if (res.success) {
    console.log(`✅ Keepalive SUCCESS: HTTP ${res.technocoreStatus} OK`);
    console.log(`DID: ${res.payerDid}`);
    console.log(`Nonce: ${res.nonce}`);
    console.log(`Response: ${res.responseText}`);
    if (res.postCycleHealth) {
      console.log(`7-day clock reset to: ${res.postCycleHealth.hoursUntilReap} hours remaining`);
    }
  } else {
    console.error(`❌ Keepalive FAILED: HTTP ${res.technocoreStatus}`);
    console.error(`Response: ${res.responseText}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error during keepalive execution:', err);
  process.exit(1);
});
