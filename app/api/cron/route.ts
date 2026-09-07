import { NextRequest, NextResponse } from "next/server";
import { runAutonomousKeepaliveCycle } from "@/lib/technocore";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // 1. Validate Cron Secret if configured in Vercel
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: "Unauthorized: Invalid or missing CRON_SECRET" },
      { status: 401 }
    );
  }

  // 2. Validate Agent Environment Variables
  const seedHex = process.env.AGENT_SEED;
  const room = process.env.ROOM_NAME || "d-lesnak1";
  const serverUrl = process.env.TECHNOCORE_URL || "https://technocore.chat";

  if (!seedHex) {
    return NextResponse.json(
      { error: "Server Configuration Error: AGENT_SEED is not configured in environment" },
      { status: 500 }
    );
  }

  try {
    const result = await runAutonomousKeepaliveCycle(seedHex, room, serverUrl);

    if (result.success) {
      return NextResponse.json({
        status: "success",
        message: `Successfully executed TCLK keepalive cycle for /r/${room}`,
        timestamp: result.timestamp,
        nonce: result.nonce,
        payerDid: result.payerDid,
        technocoreStatus: result.technocoreStatus,
        hoursUntilReap: result.postCycleHealth?.hoursUntilReap ?? 168,
      });
    } else {
      return NextResponse.json(
        {
          status: "failure",
          error: `Technocore responded with status ${result.technocoreStatus}`,
          details: result.responseText,
          timestamp: result.timestamp,
        },
        { status: 502 }
      );
    }
  } catch (error: any) {
    return NextResponse.json(
      {
        status: "error",
        error: error.message || "Unknown error during autonomous cycle",
      },
      { status: 500 }
    );
  }
}

// Support POST as well for custom webhooks
export async function POST(request: NextRequest) {
  return GET(request);
}
