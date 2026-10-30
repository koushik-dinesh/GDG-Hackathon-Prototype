#!/bin/bash

# The project is the directory this script lives in.
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VEXA_DIR="$HOME/vexa"

RUN_DIR="$PROJECT_DIR/.run"
PID_DIR="$RUN_DIR/pids"

echo ""
echo "=========================================="
echo "   AI MEETING TO ACTION - SHUTDOWN"
echo "=========================================="
echo ""

# Stop a process and its child processes recursively.
stop_process_tree() {
    PID="$1"

    CHILDREN=$(pgrep -P "$PID" 2>/dev/null || true)

    for CHILD in $CHILDREN; do
        stop_process_tree "$CHILD"
    done

    kill -TERM "$PID" 2>/dev/null || true
}

# Stop only application processes tracked by start.sh.
for NAME in frontend worker backend; do
    PID_FILE="$PID_DIR/$NAME.pid"

    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")

        if kill -0 "$PID" 2>/dev/null; then
            echo "Stopping $NAME..."
            stop_process_tree "$PID"
        else
            echo "$NAME is already stopped."
        fi

        rm -f "$PID_FILE"
    else
        echo "No tracked process for $NAME."
    fi
done

echo ""
echo "Stopping application Docker services..."

cd "$PROJECT_DIR"
docker compose stop

echo ""
echo "Stopping Vexa infrastructure..."

cd "$VEXA_DIR/deploy/compose"
docker compose stop

echo ""
echo "Stopping Vexa transcription..."

cd "$VEXA_DIR/deploy/transcription"
docker compose -f docker-compose.cpu.yml stop

echo ""
echo "=========================================="
echo "   SHUTDOWN COMMANDS COMPLETED"
echo "=========================================="
echo ""
echo "Application processes and Docker services"
echo "have been asked to stop."
echo ""
echo "Your Docker containers and persistent data"
echo "have NOT been deleted."
echo ""
