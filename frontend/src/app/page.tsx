"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  LiveKitRoom,
  useLocalParticipant,
  useIsSpeaking,
  useConnectionState,
  useRoomContext,
  RoomAudioRenderer,
} from "@livekit/components-react";
import { ConnectionState } from "livekit-client";
import { fetchToken, generateCallerId, type TokenResponse } from "@/lib/livekit";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TranscriptMessage {
  id: string;
  role: "caller" | "agent";
  text: string;
  timestamp: Date;
}

// ─── Waveform ─────────────────────────────────────────────────────────────────

function AudioWaveform({ active }: { active: boolean }) {
  return (
    <div className={`waveform ${active ? "" : "inactive"}`}>
      {[...Array(7)].map((_, i) => (
        <div key={i} className="waveform-bar" />
      ))}
    </div>
  );
}

// ─── Inner room UI (rendered inside LiveKitRoom context) ──────────────────────

function CallRoomUI({
  onTranscript,
  onDisconnect,
  callerName,
}: {
  onTranscript: (msg: TranscriptMessage) => void;
  onDisconnect: () => void;
  callerName: string;
}) {
  const { localParticipant } = useLocalParticipant();
  const isSpeaking = useIsSpeaking(localParticipant);
  const connectionState = useConnectionState();
  const [isMuted, setIsMuted] = useState(false);

  // Enable microphone on mount
  useEffect(() => {
    localParticipant?.setMicrophoneEnabled(true);
  }, [localParticipant]);

  const room = useRoomContext();

  // Listen for room data messages (transcript events from agent)
  useEffect(() => {
    if (!room) return;

    const handleData = (payload: Uint8Array, participant: any) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg.event === "transcript") {
          onTranscript({
            id: Date.now().toString(),
            role: msg.role === "agent" ? "agent" : "caller",
            text: msg.text,
            timestamp: new Date(),
          });
        }
      } catch {}
    };

    room.on("dataReceived", handleData);
    return () => { room.off("dataReceived", handleData); };
  }, [room, onTranscript]);

  const toggleMute = () => {
    localParticipant?.setMicrophoneEnabled(isMuted);
    setIsMuted(!isMuted);
  };

  const stateLabel =
    connectionState === ConnectionState.Connected ? "Connected" :
    connectionState === ConnectionState.Connecting ? "Connecting…" :
    connectionState === ConnectionState.Reconnecting ? "Reconnecting…" :
    "Disconnected";

  return (
    <div className="call-room-ui fade-in">
      <RoomAudioRenderer />

      {/* Status */}
      <div className="call-status-row">
        <span className={`call-status-dot ${connectionState === ConnectionState.Connected ? "connected" : "connecting"}`} />
        <span className="call-status-label">{stateLabel}</span>
      </div>

      {/* Speaking indicator */}
      <div className="speaking-indicator">
        <AudioWaveform active={isSpeaking && !isMuted} />
        <p className="speaking-label">
          {isSpeaking && !isMuted ? "You're speaking…" : "Listening to agent…"}
        </p>
      </div>

      {/* Controls */}
      <div className="call-controls">
        <button
          className={`btn ${isMuted ? "btn-ghost" : "btn-ghost"} btn-icon`}
          onClick={toggleMute}
          title={isMuted ? "Unmute" : "Mute"}
          id="btn-mute"
        >
          {isMuted ? "🔇" : "🎙"}
        </button>
        <button
          className="btn btn-danger"
          onClick={onDisconnect}
          id="btn-end-call"
        >
          End Call
        </button>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function CallerPage() {
  const [phase, setPhase] = useState<"idle" | "setup" | "connecting" | "in-call" | "ended">("idle");
  const [callerName, setCallerName] = useState("");
  const [roomName, setRoomName] = useState("appointment-room");
  const [tokenData, setTokenData] = useState<TokenResponse | null>(null);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const callerId = useRef(generateCallerId());

  // Auto-scroll transcript
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcript]);

  const handleAddTranscript = useCallback((msg: TranscriptMessage) => {
    setTranscript(prev => [...prev, msg]);
  }, []);

  const startCall = async () => {
    if (!callerName.trim()) return;
    setPhase("connecting");
    setError(null);
    try {
      const data = await fetchToken(
        `${callerId.current}`,
        roomName,
        "caller"
      );
      setTokenData(data);
      setPhase("in-call");
    } catch (e: any) {
      setError(e.message || "Failed to connect. Is the backend running?");
      setPhase("setup");
    }
  };

  const endCall = () => {
    setTokenData(null);
    setPhase("ended");
  };

  return (
    <main className="caller-page">
      {/* Header */}
      <header className="caller-header">
        <div className="logo-mark">
          <span className="logo-icon">🎙</span>
          <span className="logo-text">ConvoAgent</span>
        </div>
        <a href="/monitor" className="btn btn-ghost btn-sm" id="link-monitor">
          📊 Monitor Dashboard →
        </a>
      </header>

      <div className="caller-content">
        {/* Left: hero */}
        <div className="caller-hero">
          <div className="hero-badge badge badge-listening">
            <span className="dot-pulse" style={{ background: "#10b981" }} />
            AI Agent Online
          </div>
          <h1 className="hero-title">
            Talk to<br />
            <span className="hero-gradient">Agent Alex</span>
          </h1>
          <p className="hero-subtitle">
            Your intelligent scheduling assistant. Book appointments, get answers, 
            and connect with our team — all through natural conversation.
          </p>
          <div className="hero-features">
            {[
              { icon: "📅", label: "Book Appointments" },
              { icon: "🔄", label: "Live Transfer" },
              { icon: "🤖", label: "AI Powered" },
            ].map(f => (
              <div key={f.label} className="hero-feature">
                <span>{f.icon}</span>
                <span>{f.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right: call card */}
        <div className="caller-card card">
          {phase === "idle" && (
            <div className="card-body fade-in">
              <h2 className="card-title">Start a Call</h2>
              <p className="card-subtitle">Enter your name to begin</p>
              <div className="form-group">
                <label className="form-label">Your Name</label>
                <input
                  id="input-caller-name"
                  className="input"
                  placeholder="e.g. John Smith"
                  value={callerName}
                  onChange={e => setCallerName(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && setPhase("setup")}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Room</label>
                <input
                  id="input-room-name"
                  className="input"
                  placeholder="appointment-room"
                  value={roomName}
                  onChange={e => setRoomName(e.target.value)}
                />
              </div>
              <button
                id="btn-start-call"
                className="btn btn-primary btn-lg"
                style={{ width: "100%", marginTop: "8px" }}
                disabled={!callerName.trim()}
                onClick={() => setPhase("setup")}
              >
                🎙 Continue
              </button>
            </div>
          )}

          {phase === "setup" && (
            <div className="card-body fade-in">
              <h2 className="card-title">Ready to connect</h2>
              <div className="setup-info">
                <div className="setup-row">
                  <span className="setup-key">Name</span>
                  <span className="setup-val">{callerName}</span>
                </div>
                <div className="setup-row">
                  <span className="setup-key">Room</span>
                  <span className="setup-val mono">{roomName}</span>
                </div>
              </div>
              {error && <div className="error-box">{error}</div>}
              <button
                id="btn-connect"
                className="btn btn-primary btn-lg"
                style={{ width: "100%", marginTop: "8px" }}
                onClick={startCall}
              >
                📞 Connect Now
              </button>
              <button
                className="btn btn-ghost"
                style={{ width: "100%", marginTop: "8px" }}
                onClick={() => setPhase("idle")}
              >
                ← Back
              </button>
            </div>
          )}

          {phase === "connecting" && (
            <div className="card-body fade-in" style={{ textAlign: "center" }}>
              <div className="spinner" style={{ margin: "0 auto 16px" }} />
              <p>Connecting to Agent Alex…</p>
            </div>
          )}

          {phase === "in-call" && tokenData && (
            <div className="card-body fade-in">
              <h2 className="card-title">In Call with Alex</h2>
              <LiveKitRoom
                token={tokenData.token}
                serverUrl={tokenData.url}
                connect={true}
                audio={true}
                video={false}
                onDisconnected={endCall}
              >
                <CallRoomUI
                  callerName={callerName}
                  onTranscript={handleAddTranscript}
                  onDisconnect={endCall}
                />
              </LiveKitRoom>

              {/* Transcript */}
              {transcript.length > 0 && (
                <div className="transcript-mini" ref={transcriptRef}>
                  {transcript.map(msg => (
                    <div key={msg.id} className={`transcript-msg ${msg.role}`}>
                      <span className="transcript-role">
                        {msg.role === "agent" ? "Alex" : callerName}
                      </span>
                      <span className="transcript-text">{msg.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {phase === "ended" && (
            <div className="card-body fade-in" style={{ textAlign: "center" }}>
              <div style={{ fontSize: "3rem", marginBottom: "16px" }}>✅</div>
              <h2 className="card-title">Call Ended</h2>
              <p className="card-subtitle">Thank you for calling. A summary has been generated.</p>
              <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
                <button
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  onClick={() => { setPhase("idle"); setTranscript([]); }}
                  id="btn-new-call"
                >
                  New Call
                </button>
                <a href="/monitor" className="btn btn-ghost" style={{ flex: 1 }} id="link-view-summary">
                  View Summary
                </a>
              </div>
            </div>
          )}
        </div>
      </div>

      <style jsx>{`
        .caller-page {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
        }
        .caller-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 20px 40px;
          border-bottom: 1px solid var(--border-subtle);
          backdrop-filter: blur(20px);
        }
        .logo-mark { display: flex; align-items: center; gap: 10px; }
        .logo-icon { font-size: 1.5rem; }
        .logo-text { font-size: 1.2rem; font-weight: 700; background: linear-gradient(135deg, #818cf8, #34d399); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .caller-content {
          flex: 1;
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 60px;
          align-items: center;
          padding: 60px 80px;
          max-width: 1200px;
          margin: 0 auto;
          width: 100%;
        }
        .hero-badge { margin-bottom: 20px; }
        .hero-title { font-size: 3.5rem; line-height: 1.1; margin-bottom: 20px; }
        .hero-gradient { background: linear-gradient(135deg, #818cf8 0%, #34d399 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .hero-subtitle { font-size: 1.1rem; color: var(--text-secondary); line-height: 1.7; margin-bottom: 32px; }
        .hero-features { display: flex; gap: 16px; flex-wrap: wrap; }
        .hero-feature { display: flex; align-items: center; gap: 8px; padding: 8px 16px; background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 100px; font-size: 0.85rem; color: var(--text-secondary); }
        .caller-card { padding: 0; overflow: hidden; }
        .card-body { padding: 32px; }
        .card-title { font-size: 1.5rem; margin-bottom: 8px; }
        .card-subtitle { color: var(--text-secondary); margin-bottom: 24px; }
        .form-group { margin-bottom: 16px; }
        .form-label { display: block; font-size: 0.85rem; font-weight: 500; color: var(--text-secondary); margin-bottom: 8px; }
        .setup-info { background: var(--bg-elevated); border-radius: var(--radius-md); padding: 16px; margin-bottom: 16px; }
        .setup-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border-subtle); }
        .setup-row:last-child { border-bottom: none; }
        .setup-key { color: var(--text-secondary); font-size: 0.85rem; }
        .setup-val { font-weight: 500; }
        .error-box { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: #fca5a5; padding: 12px 16px; border-radius: var(--radius-md); font-size: 0.85rem; margin-bottom: 12px; }
        .call-room-ui { }
        .call-status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 24px; }
        .call-status-dot { width: 10px; height: 10px; border-radius: 50%; animation: pulse-dot 2s infinite; }
        .call-status-dot.connected { background: var(--accent-green); }
        .call-status-dot.connecting { background: var(--accent-amber); }
        .call-status-label { font-size: 0.85rem; color: var(--text-secondary); }
        .speaking-indicator { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 24px; background: var(--bg-elevated); border-radius: var(--radius-md); margin-bottom: 16px; }
        .speaking-label { font-size: 0.85rem; color: var(--text-secondary); }
        .call-controls { display: flex; gap: 12px; align-items: center; justify-content: center; }
        .transcript-mini { margin-top: 16px; max-height: 200px; overflow-y: auto; background: var(--bg-elevated); border-radius: var(--radius-md); padding: 12px; display: flex; flex-direction: column; gap: 8px; }
        .transcript-msg { display: flex; flex-direction: column; gap: 2px; }
        .transcript-msg.agent { align-items: flex-start; }
        .transcript-msg.caller { align-items: flex-end; }
        .transcript-role { font-size: 0.7rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
        .transcript-text { font-size: 0.85rem; padding: 8px 12px; border-radius: var(--radius-sm); max-width: 85%; }
        .transcript-msg.agent .transcript-text { background: rgba(99,102,241,0.15); color: var(--text-primary); }
        .transcript-msg.caller .transcript-text { background: rgba(16,185,129,0.15); color: var(--text-primary); }
        @media (max-width: 900px) {
          .caller-content { grid-template-columns: 1fr; padding: 32px 24px; gap: 32px; }
          .hero-title { font-size: 2.5rem; }
        }
      `}</style>
    </main>
  );
}
