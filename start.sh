#!/bin/bash
echo "🚀 Starting ConvoAgent Services..."

# Kill any existing processes on ports 3000 and 8000
fuser -k 3000/tcp 2>/dev/null
fuser -k 8000/tcp 2>/dev/null
pkill -f "python agent.py"

# 1. Start FastAPI Backend (Port 8000)
echo "📦 Starting FastAPI Server..."
cd backend
source venv/bin/activate
uvicorn server:app --port 8000 > ../server.log 2>&1 &
SERVER_PID=$!

# 2. Start Next.js Frontend (Port 3000)
echo "🌐 Starting Next.js Frontend..."
cd ../frontend
npm run dev > ../frontend.log 2>&1 &
FRONTEND_PID=$!

# 3. Start LiveKit Agent Worker
echo "🤖 Starting AI Voice Agent..."
cd ../backend
python agent.py dev > ../agent.log 2>&1 &
AGENT_PID=$!

echo "✅ All services started!"
echo "👉 Frontend (Caller UI & Monitor): http://localhost:3000"
echo "👉 Backend API: http://localhost:8000"
echo "📄 Logs are being written to server.log, frontend.log, and agent.log"
echo "Press Ctrl+C to stop all services."

trap "echo '🛑 Stopping all services...'; kill $SERVER_PID $FRONTEND_PID $AGENT_PID; exit" INT TERM
wait
