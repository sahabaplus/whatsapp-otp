// notification_service.ts
import redis from "redis";
import { EventEmitter } from "events";
import pino from "pino";
import { createPinoTransports } from "./logger";

export interface INotification {
  phoneNumber?: string; // Make optional to handle both formats
  phone?: string; // Support both phoneNumber and phone
  message: string;
  timestamp?: string;
  retryCount?: number;
  mediaType?: "text" | "image" | "video" | "document" | "audio";
  mediaPath?: string; // Path to media file
  caption?: string; // For media messages
  fileName?: string; // For document messages
}

export enum NotificationEvents {
  MESSAGE_RECEIVED = "messageReceived",
  PROCESSING_ERROR = "processingError",
  SERVICE_ERROR = "serviceError",
  SERVICE_STARTED = "serviceStarted",
  SERVICE_STOPPED = "serviceStopped",
  CONNECTION_RESTORED = "connectionRestored",
  RETRY_FAILED = "retryFailed",
}

export class NotificationService extends EventEmitter {
  private readonly subscriber: redis.RedisClientType;
  private readonly redis: redis.RedisClientType;
  private readonly queueName: string = "send_otp:queue";
  private readonly processingQueueName: string = "send_otp:processing";
  private readonly failedQueueName: string = "send_otp:failed";
  private readonly retryQueueName: string = "send_otp:retry";

  private isRunning: boolean = false;
  private processingInterval: NodeJS.Timer | null = null;
  private retryInterval: NodeJS.Timer | null = null;
  private connectionCheckInterval: NodeJS.Timer | null = null;
  private maxRetries: number = 3;
  private retryDelay: number = 30000; // 30 seconds

  private readonly logger = pino(
    {
      level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
    },
    pino.transport(createPinoTransports())
  );

  constructor() {
    super();

    // Create Redis clients with better error handling
    this.subscriber = redis.createClient({
      url: Bun.env.REDIS_URL || process.env.REDIS_URL,
      password: Bun.env.REDIS_PASSWORD || process.env.REDIS_PASSWORD,
      socket: {
        reconnectStrategy: (retries) => {
          this.logger.debug(
            { retries, client: "subscriber" },
            "Redis reconnect attempt"
          );
          return Math.min(retries * 100, 3000);
        },
      },
    });

    this.redis = redis.createClient({
      url: Bun.env.REDIS_URL || process.env.REDIS_URL,
      password: Bun.env.REDIS_PASSWORD || process.env.REDIS_PASSWORD,
      socket: {
        reconnectStrategy: (retries) => {
          this.logger.debug(
            { retries, client: "redis" },
            "Redis reconnect attempt"
          );
          return Math.min(retries * 100, 3000);
        },
      },
    });

    this.setupRedisConnections();
  }

  private async setupRedisConnections() {
    try {
      // Set up error handlers before connecting
      this.subscriber.on("error", (error) => {
        this.logger.error(
          { err: error, client: "subscriber" },
          "Redis subscriber error"
        );
        this.handleError(error);
      });

      this.redis.on("error", (error) => {
        this.logger.error(
          { err: error, client: "redis" },
          "Redis client error"
        );
        this.handleError(error);
      });

      // Connection event handlers
      this.subscriber.on("connect", () => {
        this.logger.info(
          { client: "subscriber" },
          "Redis subscriber connected"
        );
      });

      this.redis.on("connect", () => {
        this.logger.info({ client: "redis" }, "Redis client connected");
      });

      this.subscriber.on("reconnecting", () => {
        this.logger.info(
          { client: "subscriber" },
          "Redis subscriber reconnecting"
        );
      });

      this.redis.on("reconnecting", () => {
        this.logger.info({ client: "redis" }, "Redis client reconnecting");
      });

      // Connect to Redis
      await Promise.all([this.subscriber.connect(), this.redis.connect()]);

      this.logger.info("Redis connections established");
    } catch (error) {
      this.logger.error({ err: error }, "Failed to setup Redis connections");
      throw error;
    }
  }

  private handleError(error: Error) {
    this.emit(NotificationEvents.SERVICE_ERROR, error);
  }

  async start() {
    try {
      this.isRunning = true;

      // Start processing messages from main queue
      this.startMessageProcessing();

      // Start retry processing
      this.startRetryProcessing();

      // Start connection health check
      this.startConnectionHealthCheck();

      this.emit(NotificationEvents.SERVICE_STARTED);
      this.logger.info("Notification service started successfully");
    } catch (error) {
      this.handleError(error as Error);
      throw error;
    }
  }

  async stop() {
    this.logger.info("Stopping notification service");

    this.isRunning = false;

    // Clear intervals
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }

    if (this.connectionCheckInterval) {
      clearInterval(this.connectionCheckInterval);
      this.connectionCheckInterval = null;
    }

    await this.cleanup();
    this.emit(NotificationEvents.SERVICE_STOPPED);
    this.logger.info("Notification service stopped");
  }

  private startMessageProcessing() {
    const processMessages = async () => {
      if (!this.isRunning) return;

      try {
        // Process one message at a time with timeout
        const message = await this.redis.BRPOPLPUSH(
          this.queueName,
          this.processingQueueName,
          1 // 1 second timeout
        );

        if (message) {
          this.logger.info("Processing new message from queue");
          await this.processMessage(message);

          // Remove from processing queue after successful processing
          await this.redis.LREM(this.processingQueueName, 1, message);
        }
      } catch (error) {
        this.logger.error({ err: error }, "Error in message processing");
        this.emit(NotificationEvents.PROCESSING_ERROR, error);

        // Wait before retrying to prevent tight error loop
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Continue processing
      if (this.isRunning) {
        setImmediate(processMessages);
      }
    };

    // Start processing
    processMessages();
  }

  private startRetryProcessing() {
    this.retryInterval = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        // Process retry queue
        const retryMessage = await this.redis.BRPOPLPUSH(
          this.retryQueueName,
          this.processingQueueName,
          1
        );

        if (retryMessage) {
          this.logger.info("Processing retry message");
          await this.processMessage(retryMessage, true);
          await this.redis.LREM(this.processingQueueName, 1, retryMessage);
        }
      } catch (error) {
        this.logger.error({ err: error }, "Error in retry processing");
        this.emit(NotificationEvents.PROCESSING_ERROR, error);
      }
    }, this.retryDelay);
  }

  private startConnectionHealthCheck() {
    this.connectionCheckInterval = setInterval(async () => {
      try {
        // Simple ping to check Redis connection
        await this.redis.ping();

        // Move any stuck messages from processing back to main queue
        await this.recoverStuckMessages();
      } catch (error) {
        this.logger.error({ err: error }, "Connection health check failed");
        this.handleError(error as Error);
      }
    }, 60000); // Check every minute
  }

  private async recoverStuckMessages() {
    try {
      // Move messages stuck in processing queue back to main queue
      // This handles cases where the service crashed while processing
      const stuckMessages = await this.redis.LRANGE(
        this.processingQueueName,
        0,
        -1
      );

      if (stuckMessages.length > 0) {
        this.logger.info(
          { count: stuckMessages.length },
          "Recovering stuck messages"
        );

        for (const message of stuckMessages) {
          await this.redis.LPUSH(this.queueName, message);
          await this.redis.LREM(this.processingQueueName, 1, message);
        }
      }
    } catch (error) {
      this.logger.error({ err: error }, "Error recovering stuck messages");
    }
  }

  private async processMessage(message: string, isRetry: boolean = false) {
    try {
      const notification: INotification = JSON.parse(message);

      // Normalize phone number field
      if (!notification.phoneNumber && notification.phone) {
        notification.phoneNumber = notification.phone;
      }

      if (!notification.phoneNumber) {
        throw new Error("Missing phone number in notification");
      }

      // Initialize retry count if not present
      if (typeof notification.retryCount !== "number") {
        notification.retryCount = 0;
      }

      this.logger.info(
        {
          phoneNumber: notification.phoneNumber,
          messageLength: notification.message?.length || 0,
          mediaType: notification.mediaType || "text",
          retryCount: notification.retryCount,
          isRetry,
        },
        "Processing notification"
      );

      this.emit(NotificationEvents.MESSAGE_RECEIVED, notification);
    } catch (error) {
      this.logger.error({ err: error }, "Error parsing notification");

      // Try to parse partial data for retry logic
      try {
        const partialNotification = JSON.parse(message);
        await this.handleFailedMessage(
          message,
          partialNotification,
          error as Error
        );
      } catch (parseError) {
        // Complete parsing failure - move to failed queue
        await this.redis.LPUSH(this.failedQueueName, message);
        this.logger.error(
          { err: parseError },
          "Message moved to failed queue due to parse error"
        );
      }

      this.emit(NotificationEvents.PROCESSING_ERROR, { message, error });
    }
  }

  public async handleFailedMessage(
    originalMessage: string,
    notification: Partial<INotification>,
    error: Error
  ) {
    try {
      const retryCount = (notification.retryCount || 0) + 1;

      if (retryCount <= this.maxRetries) {
        this.logger.info(
          { retryCount, maxRetries: this.maxRetries },
          "Scheduling retry for message"
        );

        // Update retry count
        const updatedNotification = {
          ...notification,
          retryCount,
        };

        // Add to retry queue
        await this.redis.LPUSH(
          this.retryQueueName,
          JSON.stringify(updatedNotification)
        );
      } else {
        this.logger.error(
          { maxRetries: this.maxRetries },
          "Max retries reached, moving to failed queue"
        );

        // Add to failed queue with error info
        const failedNotification = {
          ...notification,
          retryCount,
          lastError: error.message,
          failedAt: new Date().toISOString(),
        };

        await this.redis.LPUSH(
          this.failedQueueName,
          JSON.stringify(failedNotification)
        );
        this.emit(NotificationEvents.RETRY_FAILED, failedNotification);
      }
    } catch (queueError) {
      this.logger.error({ err: queueError }, "Error handling failed message");
      this.emit(NotificationEvents.SERVICE_ERROR, queueError);
    }
  }

  public async getQueueStats() {
    try {
      const [mainQueue, processingQueue, retryQueue, failedQueue] =
        await Promise.all([
          this.redis.LLEN(this.queueName),
          this.redis.LLEN(this.processingQueueName),
          this.redis.LLEN(this.retryQueueName),
          this.redis.LLEN(this.failedQueueName),
        ]);

      return {
        mainQueue,
        processingQueue,
        retryQueue,
        failedQueue,
        total: mainQueue + processingQueue + retryQueue,
      };
    } catch (error) {
      this.logger.error({ err: error }, "Error getting queue stats");
      return {
        mainQueue: -1,
        processingQueue: -1,
        retryQueue: -1,
        failedQueue: -1,
        total: -1,
      };
    }
  }

  public async reprocessFailedMessages(limit: number = 10) {
    try {
      this.logger.info({ limit }, "Reprocessing failed messages");

      for (let i = 0; i < limit; i++) {
        const failedMessage = await this.redis.RPOP(this.failedQueueName);
        if (!failedMessage) break;

        try {
          const notification = JSON.parse(failedMessage);
          // Reset retry count for reprocessing
          notification.retryCount = 0;
          delete notification.lastError;
          delete notification.failedAt;

          await this.redis.LPUSH(this.queueName, JSON.stringify(notification));
          this.logger.info("Moved failed message back to main queue");
        } catch (parseError) {
          // Put back if can't parse
          await this.redis.LPUSH(this.failedQueueName, failedMessage);
          this.logger.error(
            { err: parseError },
            "Could not reprocess failed message"
          );
        }
      }
    } catch (error) {
      this.logger.error({ err: error }, "Error reprocessing failed messages");
    }
  }

  private async cleanup() {
    try {
      this.logger.info("Cleaning up Redis connections");

      await Promise.all([this.subscriber.quit(), this.redis.quit()]);

      this.logger.info("Redis connections closed");
    } catch (error) {
      this.logger.error({ err: error }, "Error during cleanup");
    }
  }
}
