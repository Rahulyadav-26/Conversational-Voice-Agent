"""
agent.py — Agent A: Conversational Voice Agent

This is the LiveKit agent entrypoint. It:
  1. Initialises an AgentSession with Groq LLM, Deepgram STT, and Cartesia TTS
  2. Holds an appointment-booking conversation with the caller
  3. Publishes real-time state (listening/thinking/speaking/intent/action) via participant attributes
  4. Handles watcher takeover via RPC
  5. Supports warm transfer via Twilio SIP (see tools.py)
  6. Generates and stores a post-call summary on disconnect

Run with:
    python agent.py dev           # development mode (single room)
    python agent.py start         # production mode (dispatch)
"""

import asyncio
import json
import logging
import os
import time
from datetime import datetime
from typing import Optional

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RoomInputOptions,
    WorkerOptions,
    WorkerType,
    cli,
    function_tool,
    metrics,
)
from livekit.agents.llm import ChatContext, ChatMessage
from livekit.plugins import cartesia, deepgram, groq

from database import init_db, save_call_summary
from tools import ALL_TOOLS

load_dotenv()

logger = logging.getLogger("agent-a")

# ─── System Prompt ─────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """
You are Alex, a friendly and professional scheduling assistant for a medical clinic.
Your job is to help callers book appointments and answer general questions about clinic services.

## Your Capabilities
1. **Book Appointments**: Collect name, reason for visit, preferred date/time, and contact phone number.
   - Always call check_availability() before confirming.
   - Then call book_appointment() to finalise the booking.
   - Read the full confirmation details back to the caller.

2. **Warm Transfer**: When a caller mentions billing issues, complaints, urgent matters, or explicitly
   asks to speak to a person/manager, use initiate_warm_transfer() immediately.
   - Before transferring, briefly summarize the call reason.

## Guidelines
- Be concise and conversational. Avoid long monologues.
- Collect information one piece at a time, naturally.
- If the caller doesn't give a date, suggest "this week" and confirm a specific day.
- Use 24-hour time format internally but speak in 12-hour format to callers.
- Always confirm details before booking (read back the full slot).
- If a slot is unavailable, immediately offer 2 alternative times.
- If you don't know an answer, offer to have someone call back.
- Never make up information about doctors, services, or policies.

## Conversation Start
Greet the caller warmly and ask how you can help them today.
""".strip()


# ─── Agent Class ──────────────────────────────────────────────────────────────

class VoiceAgent(Agent):
    """Agent A — voice agent with appointment booking and warm transfer capabilities."""

    def __init__(self) -> None:
        super().__init__(
            instructions=SYSTEM_PROMPT,
            tools=ALL_TOOLS,
        )
        self._call_start_time: Optional[float] = None
        self._watcher_has_control: bool = False

    # ── RPC handlers ────────────────────────────────────────────────────────

    async def _handle_takeover_rpc(
        self, data: rtc.RpcInvocationData
    ) -> str:
        """Watcher takes over the call — agent mutes itself and pauses."""
        logger.info("Watcher initiated takeover")
        self._watcher_has_control = True

        await self.session.room.local_participant.set_attributes({
            "agent_state": "paused",
            "agent_action": "Watcher has taken over the call",
        })

        # Interrupt current speech and pause STT
        self.session.interrupt()
        await self.session.set_input_audio_enabled(False)

        await self.session.say(
            "I'm connecting you with a team member now. Please hold on."
        )
        await self.session.set_output_audio_enabled(False)  # mute agent TTS

        return json.dumps({"status": "ok", "message": "Agent paused"})

    async def _handle_return_to_agent_rpc(
        self, data: rtc.RpcInvocationData
    ) -> str:
        """Watcher hands control back to agent."""
        logger.info("Watcher returned control to agent")
        self._watcher_has_control = False

        await self.session.set_input_audio_enabled(True)
        await self.session.set_output_audio_enabled(True)

        await self.session.room.local_participant.set_attributes({
            "agent_state": "listening",
            "agent_action": "Resumed from watcher handoff",
        })

        await self.session.say(
            "I'm back! Is there anything else I can help you with?"
        )
        return json.dumps({"status": "ok", "message": "Agent resumed"})

    # ── Post-call summary ────────────────────────────────────────────────────

    async def generate_and_save_summary(self, room_id: str) -> dict:
        """
        Generate a post-call summary using the LLM and save it to DB.
        Also publishes it via room data message for the monitoring UI.
        """
        duration_s = int(time.time() - self._call_start_time) if self._call_start_time else 0
        logger.info(f"Generating post-call summary, duration={duration_s}s")

        # Build a summary prompt from the conversation history
        history = self.session.chat_ctx.messages
        transcript_text = "\n".join(
            f"{m.role.upper()}: {m.content}" for m in history if m.content
        )

        summary_prompt = f"""
        Summarise the following customer service call in 3-5 sentences.
        Include: who called, their request, what was resolved, and the outcome.
        Be concise and professional.

        TRANSCRIPT:
        {transcript_text}
        """

        # Use the LLM directly for the summary (not voiced)
        llm = groq.LLM(model="llama-3.1-8b-instant")
        stream = llm.chat(
            chat_ctx=ChatContext(
                messages=[ChatMessage(role="user", content=summary_prompt)]
            )
        )
        summary_parts = []
        async for chunk in stream:
            if chunk.delta:
                summary_parts.append(chunk.delta)
        summary_text = "".join(summary_parts).strip()

        # Determine outcome from last tool call or conversation
        outcome = "completed"
        for msg in reversed(history):
            if msg.role == "tool" and msg.content:
                content = str(msg.content)
                if "transferred" in content.lower():
                    outcome = "transferred"
                    break
                elif "confirmed" in content.lower():
                    outcome = "appointment_booked"
                    break

        record = await save_call_summary(
            room_id=room_id,
            summary=summary_text,
            outcome=outcome,
            duration_s=duration_s,
        )

        # Publish to room so monitoring UI sees it instantly
        try:
            summary_payload = json.dumps({
                "event": "call_summary",
                "data": {
                    "summary": summary_text,
                    "outcome": outcome,
                    "duration_s": duration_s,
                    "room_id": room_id,
                },
            }).encode()
            await self.session.room.local_participant.publish_data(
                summary_payload, reliable=True
            )
        except Exception as e:
            logger.warning(f"Failed to publish summary data: {e}")

        return record


# ─── Job Entrypoint ───────────────────────────────────────────────────────────

async def entrypoint(ctx: JobContext) -> None:
    """
    Called by the LiveKit worker for each new room connection.
    Sets up the AgentSession pipeline and starts Agent A.
    """
    await init_db()

    logger.info(f"New call — room: {ctx.room.name}")

    # Build the voice pipeline: Groq LLM + Deepgram STT + Cartesia TTS
    session = AgentSession(
        stt=deepgram.STT(model="nova-2-general"),
        llm=groq.LLM(model="llama-3.3-70b-versatile"),
        tts=cartesia.TTS(voice="79a125e8-cd45-4c13-8a67-188112f4dd22"),  # "Lively Conversational"
    )

    agent = VoiceAgent()

    # Connect the session to the room (handles audio tracks automatically)
    await session.start(
        room=ctx.room,
        agent=agent,
        room_input_options=RoomInputOptions(
            noise_cancellation=True,
        ),
    )

    agent._call_start_time = time.time()
    
    # Register RPC handlers for watcher control
    ctx.room.local_participant.register_rpc_method("takeover", agent._handle_takeover_rpc)
    ctx.room.local_participant.register_rpc_method("return_to_agent", agent._handle_return_to_agent_rpc)

    # Publish initial state
    await ctx.room.local_participant.set_attributes({
        "agent_state": "listening",
        "agent_intent": "greeting",
        "agent_action": "Ready",
        "collected_data": "{}",
    })

    # Listen to agent state changes to update the UI
    @session.on("agent_state_changed")
    def on_state_changed(state):
        # state is an enum, e.g. AgentState.LISTENING
        state_str = str(state).split('.')[-1].lower()
        if not agent._watcher_has_control:
            asyncio.create_task(
                ctx.room.local_participant.set_attributes({"agent_state": state_str})
            )

    # Greet the caller
    await session.say(
        "Hello! Thank you for calling. I'm Alex, your scheduling assistant. "
        "How can I help you today?",
        allow_interruptions=True,
    )

    # ── Wait for the room to disconnect ──────────────────────────────────────
    disconnect_event = asyncio.Event()

    @ctx.room.on("disconnected")
    def on_room_disconnect(*args):
        disconnect_event.set()

    # Wait for the room to disconnect (dev mode automatically destroys room when empty)

    await disconnect_event.wait()

    # ── Post-call summary ─────────────────────────────────────────────────
    try:
        await agent.generate_and_save_summary(ctx.room.name)
    except Exception as e:
        logger.error(f"Failed to generate summary: {e}")

    logger.info("Agent A session ended")


# ─── Worker entry ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            worker_type=WorkerType.ROOM,  # one agent per room
        )
    )
