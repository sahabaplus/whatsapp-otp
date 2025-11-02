FROM oven/bun:1.2-alpine

# Set working directory
WORKDIR /app

# Install system dependencies for WhatsApp media processing
RUN apk add --no-cache \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev \
    librsvg-dev \
    python3 \
    make \
    g++

# Copy package files
COPY package.json bun.lockb* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# Create necessary directories
RUN mkdir -p baileys_auth_info

# Expose port (if needed for health checks)
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV LOG_LEVEL=info

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD bun run src/utils/health-check.ts || exit 1

# Run the application
CMD ["bun", "run", "src/index.ts"]