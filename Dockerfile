FROM node:22-bookworm

# Install Python and dependencies for faster-whisper
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python packages
RUN pip3 install --break-system-packages \
    "numpy<2" \
    faster-whisper

# Create app directory
WORKDIR /app

# Copy package files and install Node dependencies
COPY package.json package-lock.json* ./
RUN npm ci --production 2>/dev/null || npm install --production

# Copy application code
COPY . .

# Create directories for runtime data
RUN mkdir -p /app/sessions /app/config

# Expose ports
# 3200 = Dashboard
# 3202 = Player Bridge
EXPOSE 3200 3202

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -fk https://localhost:3200/api/health || exit 1

# Default: start with session config if provided via SESSION_CONFIG env var
CMD ["sh", "-c", "node server.js ${SESSION_CONFIG:-}"]
