import { NextRequest, NextResponse } from "next/server";
import { runAutonomousKeepaliveCycle } from "@/lib/technocore";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const clientKey = body.adminKey || request.headers.get("x-admin-key");
    const configuredKey = process.env.ADMIN_API_KEY;

    // Security: check admin key if configured
    if (configuredKey && clientKey !== configuredKey) {
      return NextResponse.json(
        { error: "Unauthorized: Invalid or missing admin key" },
        { status: 401 }
      );
    }

    const seedHex = process.env.AGENT_SEED;
    const room = process.env.ROOM_NAME || "d-lesnak1";
    const serverUrl = process.env.TECHNOCORE_URL || "https://technocore.chat";

    if (!seedHex) {
      return NextResponse.json(
        { error: "Server Configuration Error: AGENT_SEED is not configured in environment" },
        { status: 500 }
      );
    }

    const result = await runAutonomousKeepaliveCycle(seedHex, room, serverUrl);

    return NextResponse.json({
      success: result.success,
      technocoreStatus: result.technocoreStatus,
      responseText: result.responseText,
      timestamp: result.timestamp,
      nonce: result.nonce,
      preHealth: result.preCycleHealth,
      postHealth: result.postCycleHealth,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Manual trigger execution failed";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
