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
  const [callerId, setCallerId] = useState("");

  useEffect(() => {
    setCallerId(generateCallerId());
  }, []);

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
        callerId,
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
      {/* Navigation */}
      <nav className="navbar">
        <div className="nav-left">
          <div className="logo-mark">
            <span className="logo-icon">🎙</span>
            <span className="logo-text">ConvoAgent</span>
          </div>
          <span className="nav-badge">🔒 PRIVATE BY DESIGN</span>
        </div>
        <div className="nav-center">
          <a href="#" className="nav-link">Platform <span className="chevron">⌄</span></a>
          <a href="#" className="nav-link">Industry <span className="chevron">⌄</span></a>
          <a href="#" className="nav-link">Pricing</a>
          <a href="#" className="nav-link">Resources <span className="chevron">⌄</span></a>
        </div>
        <div className="nav-right">
          <a href="/monitor" className="btn btn-primary btn-sm" id="link-monitor">
            Go to Monitor
          </a>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="hero-section">
        <div className="hero-pill">
          <span className="pill-icon">🛡️</span> THE PRIVATE AI CONTROL TOWER
        </div>
        <h1 className="hero-title">
          Same Call. <span className="hero-gradient">New Experience.</span>
        </h1>
        <div className="hero-pill outline-pill">
          🔒 PRIVATE BY DESIGN · SELF-HOSTED BY DEFAULT
        </div>
        
        <p className="hero-subtitle">
          AI agents inside the tools you already use. ConvoAgent handles scheduling, answers questions naturally, and routes complex calls instantly — no wait times. 24/7 availability with sub-second latency.
        </p>

        <div className="hero-cta-group">
          <button
            className="btn btn-primary btn-lg cta-btn"
            onClick={() => {
              document.getElementById("demo-card")?.scrollIntoView({ behavior: "smooth" });
              if (phase === "idle") setPhase("setup");
            }}
          >
            Start a Call <span style={{ marginLeft: "8px" }}>→</span>
          </button>
          <a href="/monitor" className="btn btn-outline btn-lg cta-btn">
            Try the Live Demo
          </a>
        </div>

        <div className="hero-checkmarks">
          <span>✓ Sub-second latency</span>
          <span>✓ HIPAA-ready</span>
          <span>✓ Natural Voice</span>
          <span>✓ Smart Transfers</span>
        </div>
        <a href="#" className="hero-link">See all live demos ›</a>
      </section>

      {/* Dashboard / Caller Card */}
      <section className="dashboard-section" id="demo-card">
        <div className="caller-card card">
          <div className="card-top-bar">
            <div className="mac-dots">
              <span className="mac-dot red"></span>
              <span className="mac-dot yellow"></span>
              <span className="mac-dot green"></span>
            </div>
            <div className="card-top-title">ConvoAgent / Live Demo</div>
          </div>

          {phase === "idle" && (
            <div className="card-body fade-in">
              <h2 className="card-title">Start a Call</h2>
              <p className="card-subtitle">Enter your name to begin the AI voice experience</p>
              
              <div className="form-group-row">
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
              </div>

              <button
                id="btn-start-call"
                className="btn btn-primary btn-lg"
                style={{ width: "100%", marginTop: "16px" }}
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
              <div style={{ display: "flex", gap: "12px", marginTop: "16px" }}>
                <button
                  id="btn-connect"
                  className="btn btn-primary btn-lg"
                  style={{ flex: 1 }}
                  onClick={startCall}
                >
                  📞 Connect Now
                </button>
                <button
                  className="btn btn-outline btn-lg"
                  onClick={() => setPhase("idle")}
                >
                  Back
                </button>
              </div>
            </div>
          )}

          {phase === "connecting" && (
            <div className="card-body fade-in" style={{ textAlign: "center", padding: "60px 0" }}>
              <div className="spinner" style={{ margin: "0 auto 24px" }} />
              <p style={{ fontSize: "1.1rem" }}>Connecting to Agent Alex…</p>
            </div>
          )}

          {phase === "in-call" && tokenData && (
            <div className="card-body fade-in">
              <h2 className="card-title" style={{ textAlign: "center", marginBottom: "32px" }}>In Call with Alex</h2>
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
            <div className="card-body fade-in" style={{ textAlign: "center", padding: "60px 0" }}>
              <div style={{ fontSize: "4rem", marginBottom: "24px" }}>✅</div>
              <h2 className="card-title">Call Ended</h2>
              <p className="card-subtitle">Thank you for calling. A summary has been generated.</p>
              <div style={{ display: "flex", gap: "12px", marginTop: "32px", justifyContent: "center" }}>
                <button
                  className="btn btn-primary btn-lg"
                  onClick={() => { setPhase("idle"); setTranscript([]); }}
                  id="btn-new-call"
                >
                  New Call
                </button>
                <a href="/monitor" className="btn btn-outline btn-lg" id="link-view-summary">
                  View Summary
                </a>
              </div>
            </div>
          )}
        </div>
      </section>

      <style jsx>{`
        .caller-page {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          background: #000;
          color: #fff;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }

        /* Navbar */
        .navbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 40px;
          border-bottom: 1px solid rgba(255,255,255,0.08);
          background: rgba(0,0,0,0.8);
          backdrop-filter: blur(12px);
          position: sticky;
          top: 0;
          z-index: 100;
        }
        .nav-left { display: flex; align-items: center; gap: 20px; }
        .logo-mark { display: flex; align-items: center; gap: 8px; }
        .logo-icon { font-size: 1.5rem; }
        .logo-text { font-size: 1.4rem; font-weight: 800; color: #fff; letter-spacing: -0.02em; }
        .nav-badge { font-size: 0.65rem; font-weight: 700; padding: 4px 10px; border: 1px solid rgba(255,255,255,0.2); border-radius: 100px; letter-spacing: 0.05em; color: #a1a1aa; }
        
        .nav-center { display: flex; align-items: center; gap: 32px; }
        .nav-link { font-size: 0.95rem; font-weight: 500; color: #d4d4d8; text-decoration: none; transition: color 0.2s; display: flex; align-items: center; gap: 4px; }
        .nav-link:hover { color: #fff; }
        .chevron { font-size: 0.8rem; color: #71717a; margin-top: 2px; }
        .nav-right { display: flex; }

        /* Hero Section */
        .hero-section {
          padding: 80px 20px 40px;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          max-width: 900px;
          margin: 0 auto;
        }
        
        .hero-pill {
          font-size: 0.75rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          padding: 6px 16px;
          border-radius: 100px;
          background: rgba(59, 130, 246, 0.1);
          color: #93c5fd;
          margin-bottom: 24px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .outline-pill {
          background: transparent;
          border: 1px solid rgba(255,255,255,0.15);
          color: #a1a1aa;
          margin-top: 16px;
          margin-bottom: 32px;
          font-size: 0.7rem;
        }

        .hero-title {
          font-size: 5.5rem;
          font-weight: 800;
          line-height: 1.05;
          letter-spacing: -0.03em;
          color: #fff;
          margin: 0;
        }
        .hero-gradient {
          color: #3b82f6; /* Matching the blue in the screenshot */
        }
        
        .hero-subtitle {
          font-size: 1.25rem;
          line-height: 1.6;
          color: #a1a1aa;
          max-width: 800px;
          margin: 0 auto 40px;
          font-weight: 400;
        }

        .hero-cta-group {
          display: flex;
          gap: 16px;
          margin-bottom: 32px;
        }
        .cta-btn {
          padding: 16px 32px;
          font-size: 1.05rem;
          border-radius: 100px;
          font-weight: 600;
        }
        .btn-outline {
          background: transparent;
          border: 1px solid rgba(255,255,255,0.2);
          color: #fff;
          transition: all 0.2s;
        }
        .btn-outline:hover {
          background: rgba(255,255,255,0.05);
          border-color: rgba(255,255,255,0.3);
        }

        .hero-checkmarks {
          display: flex;
          gap: 24px;
          font-size: 0.85rem;
          color: #71717a;
          margin-bottom: 24px;
          font-weight: 500;
        }
        
        .hero-link {
          font-size: 0.9rem;
          color: #71717a;
          text-decoration: none;
          transition: color 0.2s;
        }
        .hero-link:hover {
          color: #a1a1aa;
        }

        /* Dashboard Section */
        .dashboard-section {
          padding: 20px;
          display: flex;
          justify-content: center;
          margin-bottom: 100px;
        }
        .caller-card {
          width: 100%;
          max-width: 900px;
          background: rgba(24, 24, 27, 0.8);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 16px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
          overflow: hidden;
        }
        .card-top-bar {
          background: rgba(39, 39, 42, 0.5);
          padding: 12px 20px;
          display: flex;
          align-items: center;
          border-bottom: 1px solid rgba(255,255,255,0.05);
          position: relative;
        }
        .mac-dots { display: flex; gap: 8px; }
        .mac-dot { width: 12px; height: 12px; border-radius: 50%; }
        .mac-dot.red { background: #ff5f56; }
        .mac-dot.yellow { background: #ffbd2e; }
        .mac-dot.green { background: #27c93f; }
        .card-top-title { position: absolute; left: 50%; transform: translateX(-50%); font-size: 0.8rem; font-weight: 500; color: #71717a; }

        .card-body { padding: 48px; }
        .card-title { font-size: 2rem; font-weight: 700; margin-bottom: 12px; text-align: center; }
        .card-subtitle { color: #a1a1aa; text-align: center; margin-bottom: 40px; font-size: 1.1rem; }
        
        .form-group-row { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px; }
        .form-group { display: flex; flex-direction: column; gap: 8px; }
        .form-label { font-size: 0.9rem; font-weight: 500; color: #d4d4d8; }
        
        .setup-info { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.05); border-radius: 12px; padding: 24px; margin-bottom: 24px; }
        .setup-row { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .setup-row:last-child { border-bottom: none; padding-bottom: 0; }
        .setup-key { color: #a1a1aa; }
        .setup-val { font-weight: 500; font-size: 1.1rem; }
        
        .error-box { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.2); color: #fca5a5; padding: 16px; border-radius: 12px; font-size: 0.95rem; margin-bottom: 24px; }
        
        .call-room-ui { display: flex; flex-direction: column; align-items: center; }
        .call-status-row { display: flex; align-items: center; gap: 10px; margin-bottom: 32px; }
        .call-status-dot { width: 12px; height: 12px; border-radius: 50%; animation: pulse-dot 2s infinite; }
        .call-status-dot.connected { background: #10b981; }
        .call-status-dot.connecting { background: #f59e0b; }
        .call-status-label { font-size: 1rem; color: #a1a1aa; font-weight: 500; }
        
        .speaking-indicator { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 32px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.05); border-radius: 16px; margin-bottom: 32px; width: 100%; max-width: 400px; }
        .speaking-label { font-size: 1rem; color: #d4d4d8; font-weight: 500; }
        
        .call-controls { display: flex; gap: 16px; }
        
        .transcript-mini { margin-top: 24px; max-height: 250px; overflow-y: auto; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.05); border-radius: 16px; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
        .transcript-msg { display: flex; flex-direction: column; gap: 4px; }
        .transcript-msg.agent { align-items: flex-start; }
        .transcript-msg.caller { align-items: flex-end; }
        .transcript-role { font-size: 0.75rem; font-weight: 700; color: #71717a; text-transform: uppercase; letter-spacing: 0.05em; }
        .transcript-text { font-size: 0.95rem; padding: 12px 16px; border-radius: 12px; max-width: 80%; line-height: 1.5; }
        .transcript-msg.agent .transcript-text { background: rgba(59, 130, 246, 0.15); border-bottom-left-radius: 4px; color: #fff; }
        .transcript-msg.caller .transcript-text { background: rgba(16, 185, 129, 0.15); border-bottom-right-radius: 4px; color: #fff; }

        @media (max-width: 900px) {
          .hero-title { font-size: 3.5rem; }
          .nav-center { display: none; }
          .form-group-row { grid-template-columns: 1fr; }
          .hero-checkmarks { flex-wrap: wrap; justify-content: center; }
        }
      `}</style>
    </main>
  );
}
