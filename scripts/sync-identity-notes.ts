import { getRoomHealth, syncRoomOwnershipAndDidNote } from '../lib/technocore';

async function main() {
  const seed = process.env.AGENT_SEED;
  if (!seed) {
    console.error('AGENT_SEED environment variable is missing.');
    process.exit(1);
  }

  const room = process.env.ROOM_NAME || 'd-lesnak1';
  const serverUrl = process.env.TECHNOCORE_URL || 'https://technocore.chat';

  console.log(`Syncing room ownership and DID note for /r/${room} on ${serverUrl}...`);
  const syncResult = await syncRoomOwnershipAndDidNote(seed, room, serverUrl);

  console.log(`DID             : ${syncResult.did}`);
  console.log(`Nonce           : ${syncResult.nonce}`);
  console.log(
    `Owner KV Claim  : ${syncResult.ownerSynced ? 'OK' : syncResult.ownerUnclaimable ? 'SKIPPED (existing room not claimable retroactively)' : 'FAILED'} (HTTP ${syncResult.ownerStatus}) -> ${syncResult.ownerResponse}`
  );
  if (syncResult.ownerConflict) {
    console.error(`Owner Conflict  : ${syncResult.ownerConflict}`);
  }
  console.log(
    `DID Note Sync   : ${syncResult.didNoteSynced ? 'OK' : 'FAILED'} (HTTP ${syncResult.didNoteStatus}, path ${syncResult.didNotePath}) -> ${syncResult.didNoteResponse}`
  );

  const health = await getRoomHealth(room, serverUrl, syncResult.did);
  console.log('----------------------------------------------------------------');
  console.log(`Room Exists     : ${health.exists}`);
  console.log(`Messages        : ${health.totalMessages}`);
  console.log(`Hours To Reap   : ${health.hoursUntilReap}`);
  console.log(`Owner Verified  : ${health.isOwnerVerified} (${health.ownerDid ?? 'none'})`);
  console.log(`DID Note Exists : ${health.didNoteExists} (${health.didNotePath ?? 'n/a'})`);

  if (syncResult.ownerConflict || !syncResult.didNoteSynced || !health.didNoteExists) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error syncing identity notes:', err);
  process.exit(1);
});
