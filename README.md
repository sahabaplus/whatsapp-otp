# WhatsApp Notification Service

A Node.js service that integrates WhatsApp messaging capabilities with Redis queue for sending automated notifications.

## Overview

This project creates a WhatsApp bot service using the Baileys library that listens to a Redis queue for notification messages and automatically sends them to specified phone numbers via WhatsApp.

## Features

- WhatsApp messaging integration via Baileys
- Redis-based notification queue system
- Automatic QR code authentication for WhatsApp Web
- Event-driven architecture for handling notifications
- TypeScript support for better type safety
- Docker support for containerized deployment

## Prerequisites

- [Node.js](https://nodejs.org/) (v14 or newer)
- [Bun](https://bun.sh/) runtime
- Redis server (local or remote)
- WhatsApp account for the bot

## Project Structure

```
.
├── baileys_store.json
├── bun.lockb
├── package-lock.json
├── package.json
├── README.md
├── src
│   ├── index.ts            # Main application entry point
│   ├── notification_service.ts  # Redis queue service
│   └── whatsapp_bot.ts     # WhatsApp integration
└── tsconfig.json
```

## Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd whatsapp-notification-service
```

2. Install dependencies:

```bash
bun install
```

## Configuration

1. Create a `.env` file in the project root:

```env
REDIS_URL=redis://localhost:6379
REDIS_PASSWORD=your_redis_password
```

You can omit the `REDIS_PASSWORD` if your Redis server doesn't require authentication.

2. Customize the queue names (optional):

If you want to use different queue names, you can modify the following constants in `notification_service.ts`:

```typescript
private readonly queueName: string = "send_otp:queue";
private readonly processingQueueName: string = "send_otp:processing";
```

## Usage

### Starting the Service

```bash
bun run src/index.ts
```

Or if you've defined a start script in package.json:

```bash
bun start
```

### WhatsApp Authentication

When you first run the service, it will generate a QR code in the terminal. Use your WhatsApp mobile app to scan this QR code:

1. Open WhatsApp on your phone
2. Tap Menu or Settings
3. Select WhatsApp Web/Desktop
4. Point your phone at the QR code displayed in the terminal

Once authenticated, the service will maintain the session in the `baileys_auth_info` directory, so you won't need to scan the QR code again unless the session expires.

### Sending Notifications

To send a notification, push a JSON message to the Redis queue named `send_otp:queue`:

```json
{
  "phoneNumber": "12345678901",
  "message": "Your OTP code is 123456"
}
```

**Important**: Phone numbers must be in international format WITHOUT the plus sign (+). For example:
- ✅ Correct: `"phoneNumber": "12345678901"` (US number)
- ✅ Correct: `"phoneNumber": "447123456789"` (UK number)
- ❌ Incorrect: `"phoneNumber": "+12345678901"`
- ❌ Incorrect: `"phoneNumber": "07123456789"` (local format)

You can use Redis CLI or any Redis client library to push messages to the queue:

```bash
redis-cli LPUSH send_otp:queue '{"phoneNumber":"12345678901","message":"Your OTP code is 123456"}'
```

## Event System

The notification service emits various events that you can listen for:

- `messageReceived`: When a notification message is received from the queue
- `processingError`: When there's an error processing a specific notification
- `serviceError`: When there's an error with the service itself
- `serviceStarted`: When the notification service starts successfully
- `serviceStopped`: When the notification service stops

These events are already handled in the `index.ts` file.

## Troubleshooting

### WhatsApp Connection Issues

- If you encounter connection issues, delete the `baileys_auth_info` directory and restart the service to re-authenticate.
- Ensure your WhatsApp account isn't connected to too many devices simultaneously.

### Redis Connection Issues

- Verify that your Redis server is running and accessible.
- Check that the `REDIS_URL` and `REDIS_PASSWORD` in your `.env` file are correct.

## Docker Deployment

This service can be containerized for easier deployment and scaling. Follow these steps to run the service with Docker:

1. Create a `Dockerfile` in the project root:

```dockerfile
FROM oven/bun:latest

WORKDIR /app

# Copy package files and install dependencies
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

# Copy source files
COPY . .

# Create directory for WhatsApp session data
RUN mkdir -p baileys_auth_info

# Run the service
CMD ["bun", "run", "src/index.ts"]
```

2. Create a `.dockerignore` file:

```
node_modules
baileys_auth_info
*.log
.env
```

3. Build the Docker image:

```bash
docker build -t whatsapp-notification-service .
```

4. Run the container:

```bash
docker run -d \
  --name whatsapp-bot \
  -p 3000:3000 \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  -e REDIS_PASSWORD=your_redis_password \
  -v $(pwd)/baileys_auth_info:/app/baileys_auth_info \
  whatsapp-notification-service
```

### Docker Compose

For a complete deployment with Redis, create a `docker-compose.yml` file:

```yaml
version: '3'

services:
  whatsapp-bot:
    build: .
    restart: always
    volumes:
      - ./baileys_auth_info:/app/baileys_auth_info
    environment:
      - REDIS_URL=redis://redis:6379
      - REDIS_PASSWORD=your_redis_password
    depends_on:
      - redis

  redis:
    image: redis:alpine
    restart: always
    command: redis-server --requirepass your_redis_password
    volumes:
      - redis-data:/data

volumes:
  redis-data:
```

Run with:

```bash
docker-compose up -d
```

**Note**: When running in Docker, you'll need to view the QR code for WhatsApp authentication. Use `docker logs whatsapp-bot` to see it.

## Production Deployment

For production deployment, consider:

- Using Kubernetes for orchestration
- Setting up monitoring and logging
- Implementing rate limiting to avoid WhatsApp blocking
- Using a reliable Redis service with persistence

## WhatsApp Usage Policy

Please ensure your use of this service complies with WhatsApp's Business API terms of service. Non-compliant messaging may result in your number being banned.

## Customization

### Modifying Message Format

To customize the message format, modify the `sendMessage` method in the `WhatsappBot` class:

```typescript
// Example: Adding a custom header to each message
public async sendMessage(params: SendMessageParams): Promise<boolean> {
  if (!this.sock) {
    throw new Error("Socket not initialized");
  }

  const customMessage = `🤖 AUTOMATED MESSAGE:\n\n${params.message}`;
  
  const response = await this.sock.sendMessage(
    `${params.phoneNumber}@s.whatsapp.net`,
    {
      text: customMessage,
    }
  );

  this.removeSessions();

  return response?.status !== proto.WebMessageInfo.Status.ERROR;
}
```

### Adding Support for Media Messages

The current implementation only supports text messages. For media messages, you would need to extend the `SendMessageParams` interface and modify the `sendMessage` method accordingly.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

[MIT](LICENSE)
