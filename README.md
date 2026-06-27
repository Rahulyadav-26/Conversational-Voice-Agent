# ConvoAgent — Conversational Voice Agent with Live Monitoring & Warm Transfer

A production-grade voice agent application built with **LiveKit Agents (Python)**, **Groq LLM**, **Deepgram STT**, **Cartesia TTS**, **Twilio SIP**, and a **Next.js** monitoring dashboard.

---

## Features

| Feature | Details |
|---|---|
| 🎙 Voice Conversation | AI agent (Alex) powered by Groq LLaMA + Deepgram STT + Cartesia TTS |
| 📅 Appointment Booking | Collects name, reason, date/time, phone → checks availability → confirms booking |
| 📊 Live Monitoring | Real-time transcript, agent state (Listening/Thinking/Speaking), collected data |
| 🎙 Watcher Takeover | Watcher can take over the live call from the browser UI |
| 📞 Warm Transfer | Twilio SIP transfer to real phone; human can accept or decline |
| 📋 Post-Call Summary | LLM-generated summary displayed in dashboard and stored in DB |

---

## Architecture

```
Caller (Browser) ──WebRTC──► LiveKit Room ◄──WebRTC── Watcher (Next.js)
                                    │
                              Agent A (Python)
                    ┌──────────────┼──────────────────┐
               Groq LLaMA    Deepgram STT        Cartesia TTS
                                  │
                         @function_tool calls
                    ┌─────────────┴────────────────┐
              check_availability()          initiate_warm_transfer()
              book_appointment()             → Twilio SIP → Human Agent
                    │
                SQLite DB
```

**Real-time state updates** via LiveKit participant attributes (no extra WebSocket needed).

---

## Project Structure

```
convoagent/
├── backend/
│   ├── agent.py         # LiveKit voice agent (AgentSession + tools)
│   ├── tools.py         # @function_tool: booking + warm transfer
│   ├── database.py      # aiosqlite appointment + summary storage
│   ├── server.py        # FastAPI: token API + data endpoints
│   ├── requirements.txt
│   └── .env.example
└── frontend/
    ├── src/app/
    │   ├── page.tsx           # Caller UI
    │   └── monitor/page.tsx   # Watcher monitoring dashboard
    ├── src/lib/livekit.ts     # Token + API helpers
    ├── .env.local.example
    └── package.json
```

---

## Setup

### Prerequisites

- Python 3.10+
- Node.js 18+
- A [LiveKit Cloud](https://cloud.livekit.io) account (free tier)
- A [Groq](https://console.groq.com) API key (free tier)
- A [Deepgram](https://console.deepgram.com) API key (free tier)
- A [Cartesia](https://cartesia.ai) API key
- A [Twilio](https://console.twilio.com) account with a SIP Trunk configured

### 1. Clone & configure

```bash
git clone <your-repo-url> convoagent
cd convoagent
```

### 2. Backend Setup

```bash
cd backend

# Install dependencies
pip install -r requirements.txt

# Copy and fill in your API keys
cp .env.example .env
# Edit .env with your LiveKit, Groq, Deepgram, Cartesia, and Twilio credentials
```

**Required `.env` values:**

| Variable | Where to get it |
|---|---|
| `LIVEKIT_URL` | LiveKit Cloud dashboard → Project settings |
| `LIVEKIT_API_KEY` | LiveKit Cloud dashboard → API Keys |
| `LIVEKIT_API_SECRET` | LiveKit Cloud dashboard → API Keys |
| `GROQ_API_KEY` | https://console.groq.com |
| `DEEPGRAM_API_KEY` | https://console.deepgram.com |
| `CARTESIA_API_KEY` | https://cartesia.ai |
| `SIP_TRUNK_HOSTNAME` | Twilio Console → Elastic SIP Trunking |
| `SIP_AUTH_USERNAME` | Twilio Console → SIP Credentials |
| `SIP_AUTH_PASSWORD` | Twilio Console → SIP Credentials |
| `HUMAN_AGENT_PHONE` | Real phone number to call for warm transfer |

### 3. Twilio SIP Trunk Setup

1. In [Twilio Console](https://console.twilio.com), go to **Elastic SIP Trunking**
2. Create a new SIP Trunk
3. Under **Origination**, add your LiveKit SIP domain as the SIP URI
4. Under **Credentials**, create a Credential List with username/password
5. Enable **Outbound Calling** and note your trunk domain (e.g. `my-trunk.pstn.twilio.com`)

### 4. LiveKit Cloud SIP Configuration

In LiveKit Cloud dashboard:
1. Go to **SIP** → **Outbound** → create an outbound trunk pointing to your Twilio SIP domain
2. Set up a **Dispatch Rule** so inbound SIP calls route to your agent

### 5. Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Copy and fill in env
cp .env.local.example .env.local
# Set NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
# Set NEXT_PUBLIC_LIVEKIT_URL=wss://your-project.livekit.cloud
```

---

## Running

### Start Backend (2 terminals)

**Terminal 1 — Token & API server:**
```bash
cd backend
uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

**Terminal 2 — Voice agent worker:**
```bash
cd backend
python agent.py dev
```

> `dev` mode starts the agent and connects to the first room it sees. For production, use `start` which waits for dispatch.

### Start Frontend

```bash
cd frontend
npm run dev
```

Open:
- **Caller UI**: http://localhost:3000
- **Monitor Dashboard**: http://localhost:3000/monitor

---

## Conversation Flows

### 1. Appointment Booking

```
Caller: "I'd like to book an appointment"
Agent:  "Of course! May I have your full name?"
Caller: "Jane Smith"
Agent:  "What's the reason for your visit?"
Caller: "Annual checkup"
Agent:  "When would you like to come in?"
Caller: "This Friday at 2pm"
Agent:  [calls check_availability("2025-08-01", "14:00")]
Agent:  "That slot is available. Your contact number please?"
Caller: "+1 555 000 1234"
Agent:  [calls book_appointment(...)]
Agent:  "You're all set! Ref APT-0001 — Jane Smith, Annual checkup,
          Friday Aug 1 at 2:00 PM. We'll send a reminder to your number."
```

### 2. Watcher Takeover

```
1. Watcher opens /monitor, joins the same room name
2. Sees live transcript and agent state update in real time
3. Clicks "Take Over Call"
   → Agent says "Connecting you with a team member now"
   → Agent mutes itself
   → Watcher's microphone unmutes
4. Caller hears the watcher directly
5. Watcher clicks "Return to Agent" to hand back control
```

### 3. Warm Transfer (Twilio SIP)

```
Caller: "I have a billing dispute, I need to talk to someone"
Agent:  [detects transfer intent]
Agent:  [calls initiate_warm_transfer("billing dispute")]
        → LiveKit WarmTransferTask dials HUMAN_AGENT_PHONE via Twilio SIP
        → Agent speaks call summary to human agent
        → Human agent has 10s to decide

If ACCEPT:
  Human says "accept" or presses 1
  → Agent bridges caller and human, exits the call
  → Dashboard shows "Transferred" status

If DECLINE / No answer:
  Agent returns to caller:
  "Our team is unavailable right now. I've logged your issue
   and someone will call you back within 2 business hours."
```

### 4. Post-Call Summary

When the call ends (any reason):
1. Agent generates a summary via Groq LLM using full conversation history
2. Summary is stored in SQLite and published via room data
3. Monitor dashboard shows the summary card immediately

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/token?identity=X&room=Y&role=caller` | Get LiveKit JWT |
| GET | `/appointments` | List all appointments |
| GET | `/summaries` | List all call summaries |
| POST | `/summary` | Save a call summary |
| GET | `/health` | Health check |

---

## Tech Stack

| Component | Technology |
|---|---|
| Voice Agent | [livekit-agents](https://github.com/livekit/agents) (Python) |
| LLM | [Groq](https://groq.com) — llama-3.3-70b-versatile |
| STT | [Deepgram](https://deepgram.com) — nova-2-general |
| TTS | [Cartesia](https://cartesia.ai) |
| Warm Transfer | [Twilio Elastic SIP Trunking](https://www.twilio.com/en-us/sip-trunking) + LiveKit `WarmTransferTask` |
| Frontend | [Next.js 14](https://nextjs.org) + [@livekit/components-react](https://github.com/livekit/components-js) |
| Database | SQLite via [aiosqlite](https://github.com/omnilib/aiosqlite) |
| Token Server | [FastAPI](https://fastapi.tiangolo.com) |

---

## Troubleshooting

**Agent not joining the room:**
- Ensure the agent worker is running (`python agent.py dev`)
- Verify `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` in `.env`

**No audio / STT not working:**
- Check `DEEPGRAM_API_KEY`
- Ensure your browser has microphone permissions

**Warm transfer not connecting:**
- Verify Twilio SIP Trunk hostname in `SIP_TRUNK_HOSTNAME`
- Check SIP credentials match your Twilio Credential List
- Confirm `HUMAN_AGENT_PHONE` is in E.164 format (e.g. `+15105550123`)

**Watcher takeover not working:**
- Ensure both caller and watcher are in the **same room name**
- Watcher must join before trying to take over
