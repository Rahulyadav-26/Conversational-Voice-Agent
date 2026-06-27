"""
tools.py — LiveKit function-tool definitions for Agent A.

Tools are exposed to the LLM via the @function_tool decorator.
The LLM calls these during conversation to:
  1. Check appointment availability
  2. Book an appointment
  3. Initiate a warm transfer via Twilio SIP
"""

import json
import logging
import os
from typing import Annotated

from livekit.agents import function_tool, RunContext
from livekit.agents.beta.workflows import WarmTransferTask, WarmTransferResult
from livekit.protocol.sip import SIPOutboundConfig

from database import check_slot_available, create_appointment

logger = logging.getLogger(__name__)

HUMAN_AGENT_PHONE = os.getenv("HUMAN_AGENT_PHONE", "+10000000000")
SIP_TRUNK_HOSTNAME = os.getenv("SIP_TRUNK_HOSTNAME", "")
SIP_AUTH_USERNAME = os.getenv("SIP_AUTH_USERNAME", "")
SIP_AUTH_PASSWORD = os.getenv("SIP_AUTH_PASSWORD", "")


# ─── Tool 1: Check Availability ──────────────────────────────────────────────

@function_tool
async def check_availability(
    ctx: RunContext,
    date: Annotated[str, "The requested date in YYYY-MM-DD format, e.g. 2025-08-15"],
    time: Annotated[str, "The requested time in HH:MM (24h) format, e.g. 14:30"],
) -> str:
    """
    Check whether the requested appointment slot is available.
    Returns a JSON string with 'available' (bool) and a human-readable 'message'.
    """
    logger.info(f"[tool] check_availability: date={date}, time={time}")

    # Update agent action visible in monitoring dashboard
    await ctx.room.local_participant.set_attributes(
        {"agent_action": f"Checking availability for {date} at {time}…"}
    )

    available = await check_slot_available(date, time)

    if available:
        msg = f"The slot on {date} at {time} is available."
    else:
        msg = f"Sorry, {date} at {time} is already booked. Please ask the caller for an alternative."

    await ctx.room.local_participant.set_attributes({"agent_action": "Availability checked"})

    return json.dumps({"available": available, "message": msg})


# ─── Tool 2: Book Appointment ─────────────────────────────────────────────────

@function_tool
async def book_appointment(
    ctx: RunContext,
    name: Annotated[str, "Full name of the caller"],
    reason: Annotated[str, "Reason for the visit or appointment"],
    date: Annotated[str, "Appointment date in YYYY-MM-DD format"],
    time: Annotated[str, "Appointment time in HH:MM (24h) format"],
    phone: Annotated[str, "Caller's contact phone number"],
) -> str:
    """
    Book an appointment slot.
    Returns a JSON string with 'success' (bool), 'appointment_id', and a 'confirmation_message'.
    Call check_availability first to confirm the slot is free.
    """
    logger.info(f"[tool] book_appointment: {name}, {date} {time}")

    await ctx.room.local_participant.set_attributes(
        {"agent_action": f"Booking appointment for {name}…"}
    )

    room_id = ctx.room.name

    # Double-check availability to guard against races
    still_available = await check_slot_available(date, time)
    if not still_available:
        await ctx.room.local_participant.set_attributes({"agent_action": "Booking failed — slot taken"})
        return json.dumps({
            "success": False,
            "appointment_id": None,
            "confirmation_message": (
                f"Unfortunately the slot at {time} on {date} was just taken. "
                "Please ask the caller for a different time."
            ),
        })

    appt = await create_appointment(
        room_id=room_id,
        name=name,
        reason=reason,
        date=date,
        time=time,
        phone=phone,
    )

    # Publish collected appointment data to room so the monitoring UI can display it live
    await ctx.room.local_participant.set_attributes({
        "agent_action": "Appointment confirmed ✓",
        "collected_data": json.dumps({
            "name": name,
            "reason": reason,
            "date": date,
            "time": time,
            "phone": phone,
            "appointment_id": appt["id"],
        }),
    })

    confirmation = (
        f"Your appointment has been confirmed! "
        f"Reference number: APT-{appt['id']:04d}. "
        f"Name: {name}. Date: {date} at {time}. "
        f"We'll send a reminder to {phone}."
    )

    return json.dumps({
        "success": True,
        "appointment_id": appt["id"],
        "confirmation_message": confirmation,
    })


# ─── Tool 3: Warm Transfer ────────────────────────────────────────────────────

@function_tool
async def initiate_warm_transfer(
    ctx: RunContext,
    reason: Annotated[
        str,
        "Brief reason for the transfer, e.g. 'billing dispute' or 'customer complaint'",
    ],
) -> str:
    """
    Initiate a warm transfer to a human agent via Twilio SIP.
    The agent will speak a summary to the human agent before they decide to accept or decline.
    Returns a JSON string with 'outcome': 'accepted', 'declined', or 'failed'.
    """
    logger.info(f"[tool] initiate_warm_transfer: reason={reason}")

    # Update room state so monitoring UI shows "Transferring…"
    await ctx.room.local_participant.set_attributes({
        "agent_state": "transferring",
        "agent_action": f"Transferring to human agent — reason: {reason}",
    })

    if not SIP_TRUNK_HOSTNAME:
        logger.warning("SIP_TRUNK_HOSTNAME not set — simulating transfer decline")
        await ctx.room.local_participant.set_attributes({
            "agent_state": "speaking",
            "agent_action": "Transfer failed — SIP not configured",
        })
        return json.dumps({
            "outcome": "failed",
            "message": "SIP trunk not configured. Returning to caller.",
        })

    try:
        result: WarmTransferResult = await WarmTransferTask(
            sip_call_to=HUMAN_AGENT_PHONE,
            sip_connection=SIPOutboundConfig(
                hostname=SIP_TRUNK_HOSTNAME,
                auth_username=SIP_AUTH_USERNAME,
                auth_password=SIP_AUTH_PASSWORD,
            ),
            chat_ctx=ctx.session.chat_ctx,  # passes full conversation history
        ).run()

        outcome = result.status  # "accepted", "declined", or "voicemail"
        logger.info(f"[tool] warm_transfer outcome: {outcome}")

        if outcome == "accepted":
            await ctx.room.local_participant.set_attributes({
                "agent_state": "transferred",
                "agent_action": "Call transferred to human agent",
            })
            return json.dumps({
                "outcome": "accepted",
                "message": "The human agent has accepted the transfer. The caller is now connected to them.",
            })
        else:
            await ctx.room.local_participant.set_attributes({
                "agent_state": "speaking",
                "agent_action": "Transfer declined — returning to caller",
            })
            return json.dumps({
                "outcome": outcome,
                "message": (
                    "The human agent is unavailable right now. "
                    "Apologize to the caller and offer to take a message or book a callback."
                ),
            })

    except Exception as e:
        logger.error(f"[tool] warm_transfer error: {e}")
        await ctx.room.local_participant.set_attributes({
            "agent_state": "speaking",
            "agent_action": "Transfer error",
        })
        return json.dumps({
            "outcome": "failed",
            "message": f"Transfer failed due to a technical error: {e}",
        })


# ─── All tools list (imported by agent.py) ───────────────────────────────────

ALL_TOOLS = [check_availability, book_appointment, initiate_warm_transfer]
