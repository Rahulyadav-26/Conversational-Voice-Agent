"""
server.py — FastAPI token & data server for the Conversational Voice Agent.

Endpoints:
  GET  /token           — Issue a LiveKit JWT for a caller or watcher
  GET  /appointments    — List all appointments from DB
  GET  /summaries       — List all post-call summaries
  POST /summary         — Called by agent to save a summary (can also be a webhook)
  GET  /health          — Health check

Run with:
    uvicorn server:app --host 0.0.0.0 --port 8000 --reload
"""

import os
import logging
from datetime import timedelta

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from livekit.api import AccessToken, VideoGrants

from database import (
    init_db,
    get_all_appointments,
    get_call_summaries,
    save_call_summary,
)

load_dotenv()

logger = logging.getLogger("server")

LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "")
LIVEKIT_URL = os.getenv("LIVEKIT_URL", "")

# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="ConvoAgent Server", version="1.0.0")

# Allow Next.js dev server + production origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001", "*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Startup ──────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def on_startup():
    await init_db()
    logger.info("Database initialised")


# ─── Token endpoint ───────────────────────────────────────────────────────────

@app.get("/token")
async def get_token(
    identity: str = Query(..., description="Participant identity"),
    room: str = Query("default-room", description="Room name to join"),
    role: str = Query("caller", description="'caller' or 'watcher'"),
):
    """
    Generate a short-lived LiveKit access token.
    Watchers get can_publish=True so they can speak during takeover.
    """
    if not LIVEKIT_API_KEY or not LIVEKIT_API_SECRET:
        raise HTTPException(status_code=500, detail="LiveKit API credentials not configured")

    is_watcher = role == "watcher"

    grants = VideoGrants(
        room_join=True,
        room=room,
        can_publish=True,         # both caller and watcher publish audio
        can_subscribe=True,
        can_publish_data=True,    # needed for watcher RPC calls
        hidden=is_watcher,        # watcher is hidden from caller's participant list
    )

    token = (
        AccessToken(api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_name("Watcher" if is_watcher else identity)
        .with_ttl(timedelta(hours=2))
        .with_grants(grants)
        .to_jwt()
    )

    return {"token": token, "url": LIVEKIT_URL, "room": room, "identity": identity}


# ─── Appointments ─────────────────────────────────────────────────────────────

@app.get("/appointments")
async def list_appointments():
    """Return all booked appointments."""
    appointments = await get_all_appointments()
    return {"appointments": appointments, "count": len(appointments)}


# ─── Call Summaries ───────────────────────────────────────────────────────────

class SummaryRequest(BaseModel):
    room_id: str
    summary: str
    outcome: str
    duration_s: int


@app.post("/summary")
async def create_summary(req: SummaryRequest):
    """Save a post-call summary (can be called by agent or webhook)."""
    record = await save_call_summary(
        room_id=req.room_id,
        summary=req.summary,
        outcome=req.outcome,
        duration_s=req.duration_s,
    )
    return {"status": "saved", "record": record}


@app.get("/summaries")
async def list_summaries():
    """Return all post-call summaries, newest first."""
    summaries = await get_call_summaries()
    return {"summaries": summaries, "count": len(summaries)}


# ─── Health ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "convoagent-server"}
