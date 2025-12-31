// index.ts
import {
  NotificationEvents,
  NotificationService,
  type INotification,
} from "./notification_service";
import { WhatsappBot } from "./whatsapp_bot";
import P from "pino";

class WhatsAppNotificationApp {
  private whatsappBot: WhatsappBot;
  private notificationService: NotificationService;
  private isShuttingDown = false;
  private statsInterval: NodeJS.Timer | null = null;

  private readonly logger = P(
    {
      timestamp: () => `,"time":"${new Date().toJSON()}"`,
      level: "info",
    },
    P.destination("./app-logs.txt")
  );

  constructor() {
    this.whatsappBot = new WhatsappBot();
    this.notificationService = new NotificationService();

    this.setupEventHandlers();
    this.setupGracefulShutdown();
  }

  async start() {
    try {
      this.logger.info("Starting WhatsApp Notification Application");

      // Initialize WhatsApp bot first
      this.logger.info("Initializing WhatsApp Bot");
      await this.whatsappBot.init();
      this.logger.info("WhatsApp Bot initialized successfully");

      // Start notification service
      this.logger.info("Starting Notification Service");
      await this.notificationService.start();
      this.logger.info("Notification Service started successfully");

      // Start periodic stats logging
      this.startStatsLogging();

      this.logger.info("WhatsApp Notification Application is running");
      this.logger.info("Use SIGTERM or SIGINT to gracefully shutdown");
    } catch (error) {
      this.logger.error({ err: error }, "Failed to start application");
      await this.shutdown();
      process.exit(1);
    }
  }

  private setupEventHandlers() {
    // Handle successful message processing
    this.notificationService.on(
      NotificationEvents.MESSAGE_RECEIVED,
      async (notification: INotification) => {
        try {
          this.logger.info(
            {
              phoneNumber: notification.phoneNumber || notification.phone,
              messageType: notification.mediaType || "text",
              retryCount: notification.retryCount || 0,
            },
            "Processing notification"
          );

          let success = false;

          if (
            notification.mediaType &&
            notification.mediaType !== "text" &&
            notification.mediaPath
          ) {
            // Handle media message
            success = await this.whatsappBot.sendMedia({
              phoneNumber: notification.phoneNumber || notification.phone!,
              media: notification.mediaPath,
              mediaType: notification.mediaType,
              caption: notification.caption,
              fileName: notification.fileName,
            });
          } else {
            // Handle text message
            success = await this.whatsappBot.sendMessage({
              phoneNumber: notification.phoneNumber || notification.phone!,
              message: notification.message,
            });
          }

          if (!success) {
            throw new Error("Message sending failed");
          }

          this.logger.info(
            {
              phoneNumber: notification.phoneNumber || notification.phone,
            },
            "Message processed successfully"
          );
        } catch (error) {
          this.logger.error(
            {
              err: error,
              phoneNumber: notification.phoneNumber || notification.phone,
            },
            "Error processing notification"
          );

          // Handle failed message with retry logic
          await this.notificationService.handleFailedMessage(
            JSON.stringify(notification),
            notification,
            error as Error
          );
        }
      }
    );

    // Handle processing errors
    this.notificationService.on(
      NotificationEvents.PROCESSING_ERROR,
      (error) => {
        this.logger.error({ err: error }, "Processing error");
      }
    );

    // Handle service errors
    this.notificationService.on(NotificationEvents.SERVICE_ERROR, (error) => {
      this.logger.error({ err: error }, "Service error");

      // Log WhatsApp connection status for debugging
      const connectionInfo = this.whatsappBot.getConnectionInfo();
      this.logger.debug({ connectionInfo }, "WhatsApp connection status");
    });

    // Handle service lifecycle events
    this.notificationService.on(NotificationEvents.SERVICE_STARTED, () => {
      this.logger.info("Notification service started");
    });

    this.notificationService.on(NotificationEvents.SERVICE_STOPPED, () => {
      this.logger.info("Notification service stopped");
    });

    this.notificationService.on(
      NotificationEvents.RETRY_FAILED,
      (notification) => {
        this.logger.error(
          {
            phoneNumber: notification.phoneNumber || notification.phone,
            retryCount: notification.retryCount,
            lastError: notification.lastError,
          },
          "Message failed after all retries"
        );
      }
    );
  }

  private startStatsLogging() {
    this.statsInterval = setInterval(async () => {
      try {
        const queueStats = await this.notificationService.getQueueStats();
        const connectionInfo = this.whatsappBot.getConnectionInfo();

        this.logger.info(
          {
            timestamp: new Date().toISOString(),
            whatsapp: {
              connected: connectionInfo.isConnected,
              reconnectAttempts: connectionInfo.reconnectAttempts,
            },
            queues: queueStats,
          },
          "Application Status"
        );

        // Alert if queues are backing up
        if (queueStats.total > 100) {
          this.logger.warn({ queueStats }, "High queue backlog detected");
        }

        // Alert if failed queue is growing
        if (queueStats.failedQueue > 10) {
          this.logger.warn(
            { failedCount: queueStats.failedQueue },
            "Many messages in failed queue"
          );
        }
      } catch (error) {
        this.logger.error({ err: error }, "Error getting application stats");
      }
    }, 30000); // Log stats every 30 seconds
  }

  private setupGracefulShutdown() {
    const handleShutdown = async (signal: string) => {
      if (this.isShuttingDown) {
        this.logger.info("Shutdown already in progress");
        return;
      }

      this.logger.info(
        { signal },
        "Received shutdown signal, starting graceful shutdown"
      );
      this.isShuttingDown = true;

      await this.shutdown();
      process.exit(0);
    };

    // Handle different shutdown signals
    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
    process.on("SIGINT", () => handleShutdown("SIGINT"));

    // Handle uncaught exceptions
    process.on("uncaughtException", async (error) => {
      this.logger.error({ err: error }, "Uncaught Exception");
      await this.shutdown();
      process.exit(1);
    });

    // Handle unhandled promise rejections
    process.on("unhandledRejection", async (reason, promise) => {
      this.logger.error({ reason, promise }, "Unhandled Rejection");
      await this.shutdown();
      process.exit(1);
    });
  }

  private async shutdown() {
    this.logger.info("Cleaning up application");

    try {
      // Stop stats logging
      if (this.statsInterval) {
        clearInterval(this.statsInterval);
        this.statsInterval = null;
      }

      // Stop notification service
      this.logger.info("Stopping notification service");
      await this.notificationService.stop();

      // Disconnect WhatsApp bot
      this.logger.info("Disconnecting WhatsApp bot");
      await this.whatsappBot.disconnect();

      this.logger.info("Application shutdown complete");
    } catch (error) {
      this.logger.error({ err: error }, "Error during shutdown");
    }
  }

  // Utility methods for monitoring and management
  public async getStatus() {
    const queueStats = await this.notificationService.getQueueStats();
    const connectionInfo = this.whatsappBot.getConnectionInfo();

    return {
      timestamp: new Date().toISOString(),
      whatsapp: connectionInfo,
      queues: queueStats,
      isShuttingDown: this.isShuttingDown,
    };
  }

  public async reprocessFailedMessages(limit: number = 10) {
    this.logger.info({ limit }, "Manually reprocessing failed messages");
    await this.notificationService.reprocessFailedMessages(limit);
  }
}

// Create logger for main function
const mainLogger = P(
  {
    timestamp: () => `,"time":"${new Date().toJSON()}"`,
    level: "info",
  },
  P.destination("./app-logs.txt")
);

// Create and start the application
async function main() {
  const app = new WhatsAppNotificationApp();

  try {
    await app.start();

    // Keep the process running
    process.stdin.resume();
  } catch (error) {
    mainLogger.error({ err: error }, "Application startup failed");
    process.exit(1);
  }
}

// Start the application
main().catch((error) => {
  mainLogger.error({ err: error }, "Fatal error");
  process.exit(1);
});
