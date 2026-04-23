#!/bin/bash
# Start script for YouTube Video API

echo "Starting YouTube Video API..."
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install Node.js first."
    exit 1
fi

# Check if npm packages are installed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "Error: Failed to install dependencies."
        exit 1
    fi
fi

# Start the main API server
echo "Starting main API server on port 3000..."
node server.js &
SERVER_PID=$!

# Start legacy API server on port 3001
echo "Starting legacy API server on port 3001..."
node api-server.js &
LEGACY_PID=$!

# Trap SIGINT and SIGTERM to clean up
cleanup() {
    echo ""
    echo "Stopping servers..."
    kill $SERVER_PID 2>/dev/null
    kill $LEGACY_PID 2>/dev/null
    echo "Servers stopped."
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for servers to finish (they won't normally)
wait