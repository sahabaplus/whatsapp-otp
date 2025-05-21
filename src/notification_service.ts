import redis from "redis";
import { EventEmitter } from "events";

export interface INotification {
  phoneNumber: string;
  message: string;
}

// Define event types for better type safety
export enum NotificationEvents {
  MESSAGE_RECEIVED = "messageReceived",
  PROCESSING_ERROR = "processingError",
  SERVICE_ERROR = "serviceError",
  SERVICE_STARTED = "serviceStarted",
  SERVICE_STOPPED = "serviceStopped",
}

export class NotificationService extends EventEmitter {
  private readonly subscriber: redis.RedisClientType;
  private readonly redis: redis.RedisClientType;
  private readonly queueName: string = "send_otp:queue";
  private readonly processingQueueName: string = "send_otp:processing";
  private isRunning: boolean = false;

  constructor() {
    super();

    // Create Redis subscriber client
    this.subscriber = redis.createClient({
      url: Bun.env.REDIS_URL,
      password: process.env.REDIS_PASSWORD,
    });

    this.redis = redis.createClient({
      url: Bun.env.REDIS_URL,
      password: process.env.REDIS_PASSWORD,
    });

    this.subscriber.connect();
    this.redis.connect();
    // Bind methods
    this.start = this.start.bind(this);
    this.stop = this.stop.bind(this);
    this.processMessage = this.processMessage.bind(this);
    this.handleError = this.handleError.bind(this);
  }

  private handleError(error: Error) {
    this.emit(NotificationEvents.SERVICE_ERROR, error);
  }

  async start() {
    try {
      // Set up error handlers
      this.subscriber.on("error", this.handleError);
      this.redis.on("error", this.handleError);

      this.isRunning = true;

      // Start processing messages
      await this.processMessages();

      this.emit(NotificationEvents.SERVICE_STARTED);
    } catch (error) {
      this.handleError(error as Error);
      throw error;
    }
  }

  async stop() {
    this.isRunning = false;
    await this.cleanup();
    this.emit(NotificationEvents.SERVICE_STOPPED);
  }

  private async processMessage(message: string) {
    try {
      const notification: INotification = JSON.parse(message);
      this.emit(NotificationEvents.MESSAGE_RECEIVED, notification);
    } catch (error) {
      this.emit(NotificationEvents.PROCESSING_ERROR, { message, error });
    }
  }

  private async processMessages() {
    while (this.isRunning) {
      try {
        const message = await this.redis.BRPOPLPUSH(
          this.queueName,
          this.processingQueueName,
          0
        );

        if (message) {
          await this.processMessage(message);
          await this.redis.LREM(this.processingQueueName, 1, message);
        }
      } catch (error) {
        this.emit(NotificationEvents.PROCESSING_ERROR, error);
        // Wait before retrying to prevent tight error loop
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async cleanup() {
    await this.subscriber.quit();
    await this.redis.quit();
  }
}
