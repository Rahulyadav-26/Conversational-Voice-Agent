"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  LiveKitRoom,
  useRoomContext,
  useRemoteParticipants,
  useConnectionState,
  RoomAudioRenderer,
} from "@livekit/components-react";
import { ConnectionState, Participant, RoomEvent } from "livekit-client";
import { fetchToken, generateCallerId, type TokenResponse } from "@/lib/livekit";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TranscriptMsg {
  id: string;
  role: "caller" | "agent" | "watcher";
  speaker: string;
  text: string;
  ts: Date;
}

interface AgentState {
  agent_state: string;    // listening | thinking | speaking | transferring | paused | transferred
  agent_intent: string;
  agent_action: string;
  collected_data: string; // JSON string
}

interface CollectedData {
  name?: string;
  reason?: string;
  date?: string;
  time?: string;
  phone?: string;
  appointment_id?: number;
}

interface CallSummary {
  summary: string;
  outcome: string;
  duration_s: number;
  room_id: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATE_CONFIG: Record<string, { label: string; emoji: string; cls: string }> = {
  listening:    { label: "Listening",    emoji: "🎙", cls: "badge-listening"    },
  thinking:     { label: "Thinking",     emoji: "🤔", cls: "badge-thinking"     },
  speaking:     { label: "Speaking",     emoji: "🔊", cls: "badge-speaking"     },
  transferring: { label: "Transferring", emoji: "📞", cls: "badge-transferring" },
  paused:       { label: "Paused",       emoji: "⏸",  cls: "badge-paused"       },
  transferred:  { label: "Transferred",  emoji: "✅", cls: "badge-listening"    },
};

function fmtDuration(s: number) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// ─── Inner dashboard (needs LiveKitRoom context) ───────────────────────────────

function MonitorDashboard({
  onSummary,
  watcherId,
  roomName,
}: {
  onSummary: (s: CallSummary) => void;
  watcherId: string;
  roomName: string;
}) {
  const room = useRoomContext();
  const remoteParticipants = useRemoteParticipants();
  const connectionState = useConnectionState();

  const [transcript, setTranscript] = useState<TranscriptMsg[]>([]);
  const [agentState, setAgentState] = useState<AgentState>({
    agent_state: "listening",
    agent_intent: "—",
    agent_action: "—",
    collected_data: "{}",
  });
  const [watcherHasControl, setWatcherHasControl] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [callStatus, setCallStatus] = useState<"connected" | "transferring" | "ended">("connected");
  const [isMicOn, setIsMicOn] = useState(false);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const localParticipant = room.localParticipant;

  // ── Timer ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    timerRef.current = setInterval(() => setCallDuration(d => d + 1), 1000);
    return () => clearInterval(timerRef.current);
  }, []);

  // ── Auto-scroll transcript ─────────────────────────────────────────────────
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcript]);

  // ── Listen to room events ──────────────────────────────────────────────────
  useEffect(() => {
    if (!room) return;

    // Data messages (transcripts, summaries, custom events)
    const handleData = (payload: Uint8Array, participant?: Participant) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));

        if (msg.event === "transcript") {
          setTranscript(prev => [...prev, {
            id: Date.now().toString() + Math.random(),
            role: msg.role,
            speaker: msg.speaker || (msg.role === "agent" ? "Alex" : "Caller"),
            text: msg.text,
            ts: new Date(),
          }]);
        }

        if (msg.event === "call_summary") {
          onSummary(msg.data);
          setCallStatus("ended");
          clearInterval(timerRef.current);
        }
      } catch (e) {}
    };

    // Participant attributes (agent state)
    const handleAttrChange = (
      changedAttributes: Record<string, string>,
      participant: Participant
    ) => {
      if (participant.isAgent || participant.identity.startsWith("agent")) {
        setAgentState(prev => ({
          ...prev,
          ...changedAttributes,
        }) as AgentState);

        if (changedAttributes.agent_state === "transferring") {
          setCallStatus("transferring");
        }
        if (changedAttributes.agent_state === "transferred") {
          setCallStatus("ended");
          clearInterval(timerRef.current);
        }
      }
    };

    room.on(RoomEvent.DataReceived, handleData);
    room.on(RoomEvent.ParticipantAttributesChanged, handleAttrChange);

    return () => {
      room.off(RoomEvent.DataReceived, handleData);
      room.off(RoomEvent.ParticipantAttributesChanged, handleAttrChange);
    };
  }, [room, onSummary]);

  // ── Also read initial agent attributes from remote participants ────────────
  useEffect(() => {
    for (const p of remoteParticipants) {
      if (p.attributes && Object.keys(p.attributes).length > 0) {
        setAgentState(prev => ({ ...prev, ...p.attributes }) as AgentState);
      }
    }
  }, [remoteParticipants]);

  // ── Takeover ───────────────────────────────────────────────────────────────
  const handleTakeover = async () => {
    // Find the agent participant
    const agentParticipant = remoteParticipants.find(
      p => p.isAgent || p.identity.startsWith("agent")
    );
    if (!agentParticipant) {
      alert("No agent found in room");
      return;
    }

    try {
      await localParticipant.performRpc({
        destinationIdentity: agentParticipant.identity,
        method: "takeover",
        payload: JSON.stringify({ watcherId }),
        responseTimeout: 5000,
      });

      // Enable watcher microphone
      await localParticipant.setMicrophoneEnabled(true);
      setIsMicOn(true);
      setWatcherHasControl(true);
    } catch (e: any) {
      alert(`Takeover failed: ${e.message}`);
    }
  };

  // ── Return to agent ────────────────────────────────────────────────────────
  const handleReturnToAgent = async () => {
    const agentParticipant = remoteParticipants.find(
      p => p.isAgent || p.identity.startsWith("agent")
    );
    if (!agentParticipant) return;

    try {
      await localParticipant.performRpc({
        destinationIdentity: agentParticipant.identity,
        method: "return_to_agent",
        payload: "{}",
        responseTimeout: 5000,
      });

      await localParticipant.setMicrophoneEnabled(false);
      setIsMicOn(false);
      setWatcherHasControl(false);
    } catch (e: any) {
      alert(`Return failed: ${e.message}`);
    }
  };

  const collectedData: CollectedData = (() => {
    try { return JSON.parse(agentState.collected_data || "{}"); }
    catch { return {}; }
  })();

  const stateInfo = STATE_CONFIG[agentState.agent_state] || STATE_CONFIG["listening"];

  return (
    <div className="monitor-grid">
      <RoomAudioRenderer />

      {/* ── Top Bar ────────────────────────────────────────────── */}
      <div className="monitor-topbar card">
        <div className="topbar-left">
          <div className="topbar-room">
            <span className="mono" style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>Room:</span>
            <span className="mono" style={{ fontSize: "0.9rem" }}>{roomName}</span>
          </div>
          <div className="topbar-timer">⏱ {fmtDuration(callDuration)}</div>
        </div>
        <div className="topbar-center">
          <span className={`badge ${
            callStatus === "connected" ? "badge-listening" :
            callStatus === "transferring" ? "badge-transferring" :
            "badge-paused"
          }`}>
            <span className="dot-pulse" style={{
              background: callStatus === "connected" ? "var(--accent-green)" :
                          callStatus === "transferring" ? "var(--accent-pink)" : "var(--text-muted)"
            }} />
            {callStatus === "connected" ? "Call Connected" :
             callStatus === "transferring" ? "Transferring…" : "Call Ended"}
          </span>
        </div>
        <div className="topbar-right">
          {!watcherHasControl ? (
            <button
              id="btn-takeover"
              className="btn btn-amber"
              onClick={handleTakeover}
              disabled={callStatus === "ended"}
            >
              🎙 Take Over Call
            </button>
          ) : (
            <button
              id="btn-return-agent"
              className="btn btn-ghost"
              onClick={handleReturnToAgent}
            >
              🤖 Return to Agent
            </button>
          )}
        </div>
      </div>

      {/* ── Takeover Banner ────────────────────────────────────── */}
      {watcherHasControl && (
        <div className="takeover-banner fade-in">
          <span>🎙 You have taken over the call — the caller can hear you directly</span>
          <button className="btn btn-sm btn-ghost" onClick={handleReturnToAgent}>Hand back</button>
        </div>
      )}

      {/* ── Main 3-column layout ──────────────────────────────── */}
      <div className="monitor-columns">

        {/* Col 1: Transcript */}
        <div className="card monitor-col">
          <div className="col-header">
            <h3 className="col-title">📝 Live Transcript</h3>
            <span className="badge badge-listening" style={{ fontSize: "0.65rem" }}>Live</span>
          </div>
          <div className="transcript-scroll" ref={transcriptRef}>
            {transcript.length === 0 ? (
              <div className="empty-state">
                <div className="spinner" />
                <p>Waiting for conversation…</p>
              </div>
            ) : (
              transcript.map(msg => (
                <div key={msg.id} className={`tx-msg tx-${msg.role} fade-in`}>
                  <div className="tx-header">
                    <span className="tx-speaker">{msg.speaker}</span>
                    <span className="tx-time">
                      {msg.ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                  </div>
                  <div className="tx-bubble">{msg.text}</div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Col 2: Agent State */}
        <div className="monitor-col" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

          {/* Agent State Card */}
          <div className="card agent-state-card">
            <div className="col-header">
              <h3 className="col-title">🤖 Agent State</h3>
            </div>
            <div className="state-display">
              <div className={`state-badge-big badge ${stateInfo.cls}`}>
                <span style={{ fontSize: "1.4rem" }}>{stateInfo.emoji}</span>
                {stateInfo.label}
              </div>
              <div className="state-details">
                <div className="state-row">
                  <span className="state-key">Intent</span>
                  <span className="state-val">{agentState.agent_intent || "—"}</span>
                </div>
                <div className="state-row">
                  <span className="state-key">Action</span>
                  <span className="state-val">{agentState.agent_action || "—"}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Participants */}
          <div className="card">
            <div className="col-header">
              <h3 className="col-title">👥 Participants</h3>
            </div>
            <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: "8px" }}>
              {remoteParticipants.length === 0 ? (
                <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>No participants yet</p>
              ) : (
                remoteParticipants.map(p => (
                  <div key={p.identity} className="participant-row">
                    <span className="participant-dot" style={{ background: p.isAgent ? "var(--accent-primary)" : "var(--accent-green)" }} />
                    <span style={{ fontSize: "0.85rem" }}>{p.identity}</span>
                    <span style={{ marginLeft: "auto", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                      {p.isAgent ? "Agent" : "Caller"}
                    </span>
                  </div>
                ))
              )}
              {/* Watcher self */}
              <div className="participant-row">
                <span className="participant-dot" style={{ background: "var(--accent-amber)" }} />
                <span style={{ fontSize: "0.85rem" }}>{watcherId}</span>
                <span style={{ marginLeft: "auto", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  You (Watcher) {watcherHasControl ? "🎙" : ""}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Col 3: Appointment Data */}
        <div className="card monitor-col">
          <div className="col-header">
            <h3 className="col-title">📅 Appointment Data</h3>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Collected live</span>
          </div>
          <div style={{ padding: "0 16px 16px", flex: 1 }}>
            {[
              { key: "name",  label: "Patient Name",  icon: "👤", val: collectedData.name  },
              { key: "reason", label: "Reason",        icon: "📋", val: collectedData.reason },
              { key: "date",  label: "Preferred Date", icon: "📅", val: collectedData.date  },
              { key: "time",  label: "Preferred Time", icon: "⏰", val: collectedData.time  },
              { key: "phone", label: "Contact Phone",  icon: "📞", val: collectedData.phone },
            ].map(field => (
              <div key={field.key} className={`data-field ${field.val ? "filled" : "empty"}`}>
                <div className="data-field-header">
                  <span className="data-icon">{field.icon}</span>
                  <span className="data-label">{field.label}</span>
                  {field.val && <span className="data-check">✓</span>}
                </div>
                <div className="data-value">
                  {field.val || <span style={{ color: "var(--text-muted)" }}>Not yet collected</span>}
                </div>
              </div>
            ))}

            {collectedData.appointment_id && (
              <div className="appt-confirmed fade-in">
                <div style={{ fontSize: "1.5rem" }}>✅</div>
                <div>
                  <div style={{ fontWeight: 600 }}>Appointment Confirmed!</div>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                    Ref: APT-{String(collectedData.appointment_id).padStart(4, "0")}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <style jsx>{`
        .monitor-grid { display: flex; flex-direction: column; gap: 16px; height: 100%; }
        .monitor-topbar { padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; }
        .topbar-left { display: flex; align-items: center; gap: 20px; }
        .topbar-room { display: flex; gap: 8px; align-items: center; }
        .topbar-timer { font-family: 'JetBrains Mono', monospace; font-size: 0.95rem; color: var(--text-secondary); }
        .topbar-center { }
        .topbar-right { }
        .takeover-banner { 
          background: linear-gradient(135deg, rgba(245,158,11,0.15), rgba(236,72,153,0.1));
          border: 1px solid rgba(245,158,11,0.4);
          border-radius: var(--radius-md);
          padding: 12px 20px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          color: #fbbf24;
          font-weight: 500;
        }
        .monitor-columns { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; flex: 1; min-height: 0; }
        .monitor-col { display: flex; flex-direction: column; overflow: hidden; }
        .col-header { display: flex; align-items: center; justify-content: space-between; padding: 16px; border-bottom: 1px solid var(--border-subtle); }
        .col-title { font-size: 0.95rem; }
        .transcript-scroll { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
        .empty-state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 40px; color: var(--text-muted); }
        .tx-msg { display: flex; flex-direction: column; gap: 4px; }
        .tx-caller { align-items: flex-end; }
        .tx-agent  { align-items: flex-start; }
        .tx-watcher { align-items: center; }
        .tx-header { display: flex; gap: 8px; align-items: center; }
        .tx-caller .tx-header { flex-direction: row-reverse; }
        .tx-speaker { font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
        .tx-time { font-size: 0.7rem; color: var(--text-muted); font-family: monospace; }
        .tx-bubble { padding: 8px 12px; border-radius: 12px; font-size: 0.85rem; max-width: 90%; line-height: 1.5; }
        .tx-agent  .tx-bubble { background: rgba(99,102,241,0.15); border-bottom-left-radius: 4px; }
        .tx-caller .tx-bubble { background: rgba(16,185,129,0.15); border-bottom-right-radius: 4px; }
        .tx-watcher .tx-bubble { background: rgba(245,158,11,0.15); }
        .agent-state-card { }
        .state-display { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
        .state-badge-big { font-size: 0.95rem; padding: 10px 18px; gap: 10px; align-self: flex-start; }
        .state-details { display: flex; flex-direction: column; gap: 8px; }
        .state-row { display: flex; gap: 8px; }
        .state-key { font-size: 0.8rem; color: var(--text-muted); min-width: 60px; }
        .state-val { font-size: 0.85rem; color: var(--text-secondary); }
        .participant-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border-subtle); }
        .participant-row:last-child { border-bottom: none; }
        .participant-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .data-field { padding: 12px; margin-bottom: 8px; border-radius: var(--radius-md); border: 1px solid var(--border-subtle); transition: var(--transition); }
        .data-field.filled { border-color: rgba(16,185,129,0.3); background: rgba(16,185,129,0.05); }
        .data-field.empty  { background: var(--bg-elevated); }
        .data-field-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
        .data-icon { font-size: 1rem; }
        .data-label { font-size: 0.75rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
        .data-check { margin-left: auto; color: var(--accent-green); font-size: 0.9rem; }
        .data-value { font-size: 0.9rem; font-weight: 500; }
        .appt-confirmed { 
          display: flex; align-items: center; gap: 12px;
          padding: 16px; margin-top: 12px;
          background: rgba(16,185,129,0.1);
          border: 1px solid rgba(16,185,129,0.3);
          border-radius: var(--radius-md);
        }
        @media (max-width: 1100px) {
          .monitor-columns { grid-template-columns: 1fr 1fr; }
        }
      `}</style>
    </div>
  );
}

// ─── Post-call Summary ────────────────────────────────────────────────────────

function PostCallSummary({ summary }: { summary: CallSummary }) {
  return (
    <div className="summary-card card fade-in">
      <div className="summary-header">
        <h3>📋 Post-Call Summary</h3>
        <span className={`badge ${summary.outcome === "appointment_booked" ? "badge-listening" : summary.outcome === "transferred" ? "badge-transferring" : "badge-paused"}`}>
          {summary.outcome?.replace("_", " ")}
        </span>
      </div>
      <p className="summary-text">{summary.summary}</p>
      <div className="summary-meta">
        <span>⏱ Duration: {fmtDuration(summary.duration_s)}</span>
        <span>🏠 Room: {summary.room_id}</span>
      </div>
      <style jsx>{`
        .summary-card { padding: 24px; margin-top: 0; }
        .summary-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
        .summary-text { color: var(--text-secondary); line-height: 1.7; margin-bottom: 16px; }
        .summary-meta { display: flex; gap: 24px; font-size: 0.8rem; color: var(--text-muted); }
      `}</style>
    </div>
  );
}

// ─── Monitor Page ─────────────────────────────────────────────────────────────

export default function MonitorPage() {
  const [phase, setPhase] = useState<"setup" | "monitoring" | "ended">("setup");
  const [roomName, setRoomName] = useState("appointment-room");
  const [tokenData, setTokenData] = useState<TokenResponse | null>(null);
  const [summary, setSummary] = useState<CallSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [watcherId, setWatcherId] = useState("");

  useEffect(() => {
    setWatcherId(`watcher-${Math.random().toString(36).slice(2, 7)}`);
  }, []);

  const joinMonitor = async () => {
    setError(null);
    try {
      const data = await fetchToken(watcherId, roomName, "watcher");
      setTokenData(data);
      setPhase("monitoring");
    } catch (e: any) {
      setError(e.message || "Failed to connect");
    }
  };

  const handleSummary = useCallback((s: CallSummary) => {
    setSummary(s);
    setPhase("ended");
  }, []);

  return (
    <div className="monitor-page">
      {/* Sidebar */}
      <aside className="monitor-sidebar">
        <div className="sidebar-logo">
          <span style={{ fontSize: "1.5rem" }}>📊</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: "1rem" }}>Monitor</div>
            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>ConvoAgent</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          <a href="/" className="nav-item">
            <span>🎙</span> New Call
          </a>
          <div className="nav-item active">
            <span>📊</span> Live Monitor
          </div>
        </nav>

        <div className="sidebar-room-info">
          <div className="sidebar-section-title">Connection</div>
          <div className="sidebar-detail">
            <span className="sidebar-key">Room</span>
            <span className="sidebar-val mono">{roomName}</span>
          </div>
          <div className="sidebar-detail">
            <span className="sidebar-key">Identity</span>
            <span className="sidebar-val mono" style={{ fontSize: "0.75rem" }}>{watcherId}</span>
          </div>
          <div className="sidebar-detail">
            <span className="sidebar-key">Status</span>
            <span className={`badge ${phase === "monitoring" ? "badge-listening" : phase === "ended" ? "badge-paused" : "badge-thinking"}`} style={{ fontSize: "0.65rem" }}>
              {phase === "monitoring" ? "Live" : phase === "ended" ? "Ended" : "Offline"}
            </span>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="monitor-main">
        {/* Header */}
        <div className="monitor-page-header">
          <div>
            <h1 style={{ fontSize: "1.5rem" }}>Live Call Monitor</h1>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>Real-time agent conversation view</p>
          </div>
        </div>

        {/* Setup */}
        {phase === "setup" && (
          <div className="setup-panel card fade-in">
            <div style={{ fontSize: "3rem", marginBottom: "16px" }}>📊</div>
            <h2>Join as Watcher</h2>
            <p style={{ color: "var(--text-secondary)", marginBottom: "24px" }}>
              Enter the room name to monitor a live call
            </p>
            <div style={{ display: "flex", gap: "12px", maxWidth: "400px" }}>
              <input
                id="input-monitor-room"
                className="input"
                placeholder="Room name"
                value={roomName}
                onChange={e => setRoomName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && joinMonitor()}
              />
              <button id="btn-join-monitor" className="btn btn-primary" onClick={joinMonitor}>
                Join
              </button>
            </div>
            {error && <div style={{ color: "#fca5a5", marginTop: "12px", fontSize: "0.85rem" }}>{error}</div>}
          </div>
        )}

        {/* Monitoring */}
        {phase === "monitoring" && tokenData && (
          <LiveKitRoom
            token={tokenData.token}
            serverUrl={tokenData.url}
            connect={true}
            audio={false}
            video={false}
            onDisconnected={() => setPhase("ended")}
            style={{ display: "contents" }}
          >
            <MonitorDashboard
              onSummary={handleSummary}
              watcherId={watcherId}
              roomName={roomName}
            />
          </LiveKitRoom>
        )}

        {/* Ended + Summary */}
        {phase === "ended" && (
          <div className="fade-in" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {summary && <PostCallSummary summary={summary} />}
            <div style={{ display: "flex", gap: "12px" }}>
              <button className="btn btn-primary" onClick={() => { setPhase("setup"); setSummary(null); }} id="btn-new-monitor">
                Monitor New Call
              </button>
              <a href="/" className="btn btn-ghost">← Back to Caller</a>
            </div>
          </div>
        )}
      </main>

      <style jsx>{`
        .monitor-page { display: flex; min-height: 100vh; }
        .monitor-sidebar {
          width: 240px;
          background: var(--bg-surface);
          border-right: 1px solid var(--border-subtle);
          display: flex; flex-direction: column;
          padding: 24px 0;
          flex-shrink: 0;
          backdrop-filter: blur(20px);
        }
        .sidebar-logo { display: flex; align-items: center; gap: 12px; padding: 0 20px 24px; border-bottom: 1px solid var(--border-subtle); margin-bottom: 16px; }
        .sidebar-nav { display: flex; flex-direction: column; gap: 4px; padding: 0 12px; }
        .nav-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--radius-md); font-size: 0.9rem; color: var(--text-secondary); cursor: pointer; transition: var(--transition); text-decoration: none; }
        .nav-item:hover { background: var(--bg-hover); color: var(--text-primary); }
        .nav-item.active { background: rgba(99,102,241,0.15); color: #818cf8; }
        .sidebar-room-info { margin-top: auto; padding: 16px 20px; border-top: 1px solid var(--border-subtle); }
        .sidebar-section-title { font-size: 0.7rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px; }
        .sidebar-detail { display: flex; flex-direction: column; gap: 2px; margin-bottom: 10px; }
        .sidebar-key { font-size: 0.72rem; color: var(--text-muted); }
        .sidebar-val { font-size: 0.82rem; word-break: break-all; }
        .monitor-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
        .monitor-page-header { padding: 20px 24px; border-bottom: 1px solid var(--border-subtle); }
        .setup-panel { text-align: center; padding: 60px; margin: 40px auto; max-width: 600px; display: flex; flex-direction: column; align-items: center; }
      `}</style>
    </div>
  );
}
