"""
database.py — Async SQLite database for appointment storage.

Uses aiosqlite so all DB operations are non-blocking and safe inside
the LiveKit agent's asyncio event loop.
"""

import asyncio
import json
import os
from datetime import datetime
from typing import Optional
import aiosqlite

DB_PATH = os.path.join(os.path.dirname(__file__), "appointments.db")

# ─── Schema ──────────────────────────────────────────────────────────────────

CREATE_APPOINTMENTS_TABLE = """
CREATE TABLE IF NOT EXISTS appointments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id     TEXT,
    name        TEXT NOT NULL,
    reason      TEXT NOT NULL,
    date        TEXT NOT NULL,
    time        TEXT NOT NULL,
    phone       TEXT NOT NULL,
    status      TEXT DEFAULT 'confirmed',
    created_at  TEXT NOT NULL
);
"""

CREATE_CALL_SUMMARIES_TABLE = """
CREATE TABLE IF NOT EXISTS call_summaries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id     TEXT NOT NULL,
    summary     TEXT NOT NULL,
    outcome     TEXT,
    duration_s  INTEGER,
    created_at  TEXT NOT NULL
);
"""

# ─── Initialisation ───────────────────────────────────────────────────────────

async def init_db() -> None:
    """Create tables if they don't exist."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(CREATE_APPOINTMENTS_TABLE)
        await db.execute(CREATE_CALL_SUMMARIES_TABLE)
        await db.commit()


# ─── Appointment helpers ──────────────────────────────────────────────────────

async def check_slot_available(date: str, time: str) -> bool:
    """Return True if the given date+time slot has no existing confirmed appointment."""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id FROM appointments WHERE date = ? AND time = ? AND status = 'confirmed'",
            (date, time),
        ) as cursor:
            row = await cursor.fetchone()
            return row is None


async def create_appointment(
    *,
    room_id: str,
    name: str,
    reason: str,
    date: str,
    time: str,
    phone: str,
) -> dict:
    """Insert a new appointment and return the record as a dict."""
    now = datetime.utcnow().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            """
            INSERT INTO appointments (room_id, name, reason, date, time, phone, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (room_id, name, reason, date, time, phone, now),
        )
        await db.commit()
        appt_id = cursor.lastrowid

    return {
        "id": appt_id,
        "room_id": room_id,
        "name": name,
        "reason": reason,
        "date": date,
        "time": time,
        "phone": phone,
        "status": "confirmed",
        "created_at": now,
    }


async def get_all_appointments() -> list[dict]:
    """Return all appointments ordered by date/time."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM appointments ORDER BY date, time"
        ) as cursor:
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]


# ─── Call summary helpers ─────────────────────────────────────────────────────

async def save_call_summary(
    *,
    room_id: str,
    summary: str,
    outcome: str,
    duration_s: int,
) -> dict:
    """Persist a post-call summary."""
    now = datetime.utcnow().isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            """
            INSERT INTO call_summaries (room_id, summary, outcome, duration_s, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (room_id, summary, outcome, duration_s, now),
        )
        await db.commit()
        summary_id = cursor.lastrowid

    return {
        "id": summary_id,
        "room_id": room_id,
        "summary": summary,
        "outcome": outcome,
        "duration_s": duration_s,
        "created_at": now,
    }


async def get_call_summaries() -> list[dict]:
    """Return all call summaries, newest first."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM call_summaries ORDER BY created_at DESC"
        ) as cursor:
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]
