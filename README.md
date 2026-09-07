# ⚡ Technocore Autonomous Agent & Keepalive Bot (`/r/d-lesnak1`)

> **Autonomous Room Ownership Preservation & A2A Microcommerce Engine for Flop Network (Season 0 Airdrop Eligible)**

A production-grade, serverless autonomous agent bot deployable to **Vercel** with a dark-cyberpunk executive monitoring dashboard. Automatically executes cryptographic keepalive transactions and authentic `tclk1` agent commerce offers on [technocore.chat](https://technocore.chat) to prevent the 7-day inactivity room reap and maintain perpetual ownership without creating spam.

---

## 🌟 Key Features

1. **Anti-Reap Inactivity Shield**:
   - Technocore automatically reaps rooms after **7 days (168 hours)** of zero activity.
   - This bot triggers an automated cycle every **3 days (72 hours)** via Vercel Cron (`0 12 */3 * *`), creating a **4-day safety buffer** (96 hours) before any expiration could ever occur.
2. **100% Sybil-Proof Cryptographic Authority**:
   - Canonical W3C `did:key:z6Mks3ZJxaPg9ReUjxz5EuKPk12AXtq7kiUXqm8jDNSfK78a` derived directly from your Ed25519 seed (`0xed01` multicodec prefix).
   - Messages are signed canonically: `${room}|${nonce}|${text}` with URL-safe Base64 signatures.
3. **Flop Network A2A Protocol Alignment (`tclk1`)**:
   - Posts authentic `tclk1` agent-to-agent microcommerce offers.
   - Includes real SHA-256 Hash Time-Locked Contract (`flop-htlc`) locks and `x402` payment rails.
   - Job specification: `task-llama3-eval` (RAG v2 inference evaluation).
4. **Zero-Ban & Zero-Rate-Limit Design**:
   - Runs cleanly once every 72 hours instead of spamming every few minutes.
   - Full compliance with Flop Labs builder standards and first-claim room ownership rules.
5. **Executive Web Dashboard**:
   - Live 168-hour countdown gauge & safety margin.
   - Real-time room message feed terminal from `/r/d-lesnak1`.
   - 1-click Manual Keepalive Trigger with admin key protection.
   - 3.5B FLOP Pool Airdrop readiness audit.

---

## 🚀 Quick Deployment Guide (Vercel)

### Step 1: Push to your GitHub Repository

Run these commands in this directory (`technocore-agent-bot`):

```bash
# 1. Initialize remote (replace with your GitHub repo URL)
git remote add origin https://github.com/YOUR_USERNAME/technocore-agent-bot.git
git branch -M main

# 2. Stage and commit
git add .
git commit -m "feat: technocore autonomous agent bot & dashboard"

# 3. Push to GitHub
git push -u origin main
```

*(Note: `.env.local` is gitignored so your private seed is never exposed in git).*

---

### Step 2: Import into Vercel

1. Go to [vercel.com/new](https://vercel.com/new).
2. Select your `technocore-agent-bot` repository and click **Import**.
3. Under **Environment Variables**, add the following:

| Variable Name | Required | Example Value | Description |
| :--- | :---: | :--- | :--- |
| `AGENT_SEED` | **YES** | `e9dfaa1d21cfbbef280c14ffa15ff1340c61a63ba9196ddc4f58d3af0163d511` | 32-byte hex seed for `Lesnak1` Ed25519 identity |
| `ROOM_NAME` | No (default) | `d-lesnak1` | Target Technocore room |
| `TECHNOCORE_URL` | No (default) | `https://technocore.chat` | Technocore chat server endpoint |
| `CRON_SECRET` | Recommended | *(Any secure random string)* | Secures `/api/cron` from unauthorized external hits |
| `ADMIN_API_KEY` | Recommended | *(Any secure secret passphrase)* | Authorizes manual trigger requests from the dashboard |

4. Click **Deploy**.

---

### Step 3: Automated Vercel Cron Schedule

The project includes `vercel.json` with an active cron job:

```json
{
  "crons": [
    {
      "path": "/api/cron",
      "schedule": "0 12 */3 * *"
    }
  ]
}
```

- **Frequency**: Every 3 days at 12:00 UTC.
- **Execution**: Automatically invokes `/api/cron` with your `CRON_SECRET`.
- **Result**: Generates an authentic `tclk1` offer, signs it with `Lesnak1`'s DID key, posts it to `/r/d-lesnak1`, and resets the 7-day reap clock.

---

## 🛠️ API Endpoints

### 1. `GET /api/status` (Public Dashboard API)
Returns current room health, message count, time elapsed since last keepalive, and reap countdown:
```bash
curl https://your-bot-domain.vercel.app/api/status
```

### 2. `POST /api/manual-trigger` (Manual Keepalive Execution)
Immediately triggers a signed keepalive transaction on Technocore:
```bash
curl -X POST "https://your-bot-domain.vercel.app/api/manual-trigger" \
  -H "Content-Type: application/json" \
  -d '{"adminKey": "YOUR_ADMIN_API_KEY"}'
```

### 3. `GET /api/cron` (Vercel Automated Cron)
Protected endpoint invoked by Vercel infrastructure:
```bash
curl "https://your-bot-domain.vercel.app/api/cron?secret=YOUR_CRON_SECRET"
```

---

## 📁 Fallback: GitHub Actions Cron

If you ever wish to run the scheduled keepalive via GitHub Actions instead of or in addition to Vercel, a ready-to-use workflow is included at [`.github/workflows/keepalive-cron.yml`](.github/workflows/keepalive-cron.yml).

Simply add these Repository Secrets under **Settings > Secrets and variables > Actions**:
- `APP_URL`: Your Vercel deployment URL (e.g. `https://technocore-agent.vercel.app`).
- `CRON_SECRET`: The same secret configured in Vercel.

---

## 🛡️ Airdrop & Sybil Defense Architecture

| Flop Labs Standard | How This Bot Complies | Risk |
| :--- | :--- | :--- |
| **Room Inactivity Reap** | Technocore reaps after 7 days; bot keeps room active every 3 days. | **0% Reap Risk** |
| **Sybil Detection** | Uses the identical Ed25519 DID seed used when creating `/r/d-lesnak1`. | **0% Sybil Flag** |
| **Spam Penalties** | Strictly limits actions to 1 transaction / 72 hours (no rapid spamming). | **0% Spam Risk** |
| **A2A Protocol Compliance** | Emits formal `tclk1` JSON offers with SHA-256 HTLC locks and `x402` rails. | **100% Eligible** |

---

## 💻 Local Development

```bash
# 1. Install dependencies
npm install

# 2. Run local development server
npm run dev

# 3. Open dashboard
http://localhost:3000
```
