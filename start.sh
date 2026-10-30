#!/bin/bash

set -e

# The project is the directory this script lives in.
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VEXA_DIR="$HOME/vexa"

RUN_DIR="$PROJECT_DIR/.run"
LOG_DIR="$RUN_DIR/logs"
PID_DIR="$RUN_DIR/pids"

mkdir -p "$LOG_DIR" "$PID_DIR"

echo ""
echo "=========================================="
echo "   AI MEETING TO ACTION - STARTUP"
echo "=========================================="
echo ""

# Check Docker
if ! docker info >/dev/null 2>&1; then
    echo "ERROR: Docker is not running."
    echo "Please open Docker Desktop and try again."
    exit 1
fi

# Check project directories
for dir in \
    "$PROJECT_DIR/backend" \
    "$PROJECT_DIR/frontend" \
    "$VEXA_DIR/deploy/transcription" \
    "$VEXA_DIR/deploy/compose"
do
    if [ ! -d "$dir" ]; then
        echo "ERROR: Directory not found: $dir"
        exit 1
    fi
done

# Start a background application process
start_process() {
    NAME="$1"
    WORK_DIR="$2"
    COMMAND="$3"

    PID_FILE="$PID_DIR/$NAME.pid"
    LOG_FILE="$LOG_DIR/$NAME.log"

    if [ -f "$PID_FILE" ]; then
        OLD_PID=$(cat "$PID_FILE")

        if kill -0 "$OLD_PID" 2>/dev/null; then
            echo "Already running: $NAME (PID $OLD_PID)"
            return
        fi

        rm -f "$PID_FILE"
    fi

    echo "Starting $NAME..."

    (
        cd "$WORK_DIR"
        exec /bin/bash -c "$COMMAND"
    ) >> "$LOG_FILE" 2>&1 &

    echo $! > "$PID_FILE"

    sleep 2

    if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "Started: $NAME"
    else
        echo "WARNING: $NAME may have failed to start."
        echo "Check log: $LOG_FILE"
    fi
}

echo "[1/6] Starting Vexa transcription service..."

cd "$VEXA_DIR/deploy/transcription"
docker compose -f docker-compose.cpu.yml up -d

echo ""
echo "[2/6] Starting Vexa meeting infrastructure..."

cd "$VEXA_DIR/deploy/compose"
docker compose up -d

echo ""
echo "[3/6] Starting application database and supporting services..."

cd "$PROJECT_DIR"
docker compose up -d

echo ""
echo "[4/6] Starting backend API..."

start_process "backend" "$PROJECT_DIR/backend" "npm run dev"

echo ""
echo "[5/6] Starting background worker..."

start_process "worker" "$PROJECT_DIR/backend" "npm run worker"

echo ""
echo "[6/6] Starting frontend..."

start_process "frontend" "$PROJECT_DIR/frontend" "npm run dev"

echo ""
echo "Waiting for services to initialize..."
sleep 5

echo ""
echo "=========================================="
echo "   STARTUP COMMANDS COMPLETED"
echo "=========================================="
echo ""
echo "Frontend:              http://localhost:5173"
echo "Backend:               http://localhost:4000"
echo "Vexa gateway:          http://localhost:18056"
echo "Vexa transcription:    http://localhost:8083"
echo "Mailpit:               http://localhost:8025"
echo ""
echo "Check transcription health:"
echo "curl http://localhost:8083/health"
echo ""
echo "Logs are stored in:"
echo "$LOG_DIR"
echo ""
echo "To stop the services, run:"
echo "./end.sh"
echo ""
