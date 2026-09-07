import { NextResponse } from "next/server";
import { getRoomHealth } from "@/lib/technocore";
import { seedToDid } from "@/lib/crypto";

export const dynamic = "force-dynamic";

export async function GET() {
  const room = process.env.ROOM_NAME || "d-lesnak1";
  const seedHex = process.env.AGENT_SEED;
  const serverUrl = process.env.TECHNOCORE_URL || "https://technocore.chat";

  let agentDid: string | null = null;
  if (seedHex) {
    try {
      agentDid = seedToDid(seedHex).did;
    } catch {
      // Ignored
    }
  }

  try {
    const health = await getRoomHealth(room, serverUrl, agentDid || undefined);

    return NextResponse.json({
      status: "ok",
      serverUrl,
      configuredAgent: {
        configured: Boolean(seedHex),
        did: agentDid,
        room,
        handle: "Lesnak1",
      },
      health,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to query room status";
    return NextResponse.json(
      {
        status: "error",
        error: message,
      },
      { status: 500 }
    );
  }
}
