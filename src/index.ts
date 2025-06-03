// index.ts
import {
  NotificationEvents,
  NotificationService,
  type INotification,
} from "./notification_service";
import { WhatsappBot } from "./whatsapp_bot";

class WhatsAppNotificationApp {
  private whatsappBot: WhatsappBot;
  private notificationService: NotificationService;
  private isShuttingDown = false;
  private statsInterval: NodeJS.Timer | null = null;

  constructor() {
    this.whatsappBot = new WhatsappBot();
    this.notificationService = new NotificationService();

    this.setupEventHandlers();
    this.setupGracefulShutdown();
  }

  async start() {
    try {
      console.log("🚀 Starting WhatsApp Notification Application...");

      // Initialize WhatsApp bot first
      console.log("📱 Initializing WhatsApp Bot...");
      await this.whatsappBot.init();
      console.log("✅ WhatsApp Bot initialized successfully");

      // Start notification service
      console.log("🔔 Starting Notification Service...");
      await this.notificationService.start();
      console.log("✅ Notification Service started successfully");

      // Start periodic stats logging
      this.startStatsLogging();

      console.log("🎉 WhatsApp Notification Application is running!");
      console.log("📊 Use SIGTERM or SIGINT to gracefully shutdown");
    } catch (error) {
      console.error("❌ Failed to start application:", error);
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
          console.log("📨 Processing notification:", {
            phoneNumber: notification.phoneNumber || notification.phone,
            messageType: notification.mediaType || "text",
            retryCount: notification.retryCount || 0,
          });

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

          console.log("✅ Message processed successfully");
        } catch (error) {
          console.error("❌ Error processing notification:", error);

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
        console.error("❌ Processing error:", error);
      }
    );

    // Handle service errors
    this.notificationService.on(NotificationEvents.SERVICE_ERROR, (error) => {
      console.error("❌ Service error:", error);

      // Log WhatsApp connection status for debugging
      const connectionInfo = this.whatsappBot.getConnectionInfo();
      console.log("📱 WhatsApp connection status:", connectionInfo);
    });

    // Handle service lifecycle events
    this.notificationService.on(NotificationEvents.SERVICE_STARTED, () => {
      console.log("✅ Notification service started");
    });

    this.notificationService.on(NotificationEvents.SERVICE_STOPPED, () => {
      console.log("🛑 Notification service stopped");
    });

    this.notificationService.on(
      NotificationEvents.RETRY_FAILED,
      (notification) => {
        console.error("❌ Message failed after all retries:", {
          phoneNumber: notification.phoneNumber || notification.phone,
          retryCount: notification.retryCount,
          lastError: notification.lastError,
        });
      }
    );
  }

  private startStatsLogging() {
    this.statsInterval = setInterval(async () => {
      try {
        const queueStats = await this.notificationService.getQueueStats();
        const connectionInfo = this.whatsappBot.getConnectionInfo();

        console.log("📊 Application Status:", {
          timestamp: new Date().toISOString(),
          whatsapp: {
            connected: connectionInfo.isConnected,
            reconnectAttempts: connectionInfo.reconnectAttempts,
          },
          queues: queueStats,
        });

        // Alert if queues are backing up
        if (queueStats.total > 100) {
          console.warn("⚠️  Warning: High queue backlog detected!", queueStats);
        }

        // Alert if failed queue is growing
        if (queueStats.failedQueue > 10) {
          console.warn("⚠️  Warning: Many messages in failed queue!", {
            failedCount: queueStats.failedQueue,
          });
        }
      } catch (error) {
        console.error("❌ Error getting application stats:", error);
      }
    }, 30000); // Log stats every 30 seconds
  }

  private setupGracefulShutdown() {
    const handleShutdown = async (signal: string) => {
      if (this.isShuttingDown) {
        console.log("🔄 Shutdown already in progress...");
        return;
      }

      console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
      this.isShuttingDown = true;

      await this.shutdown();
      process.exit(0);
    };

    // Handle different shutdown signals
    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
    process.on("SIGINT", () => handleShutdown("SIGINT"));

    // Handle uncaught exceptions
    process.on("uncaughtException", async (error) => {
      console.error("💥 Uncaught Exception:", error);
      await this.shutdown();
      process.exit(1);
    });

    // Handle unhandled promise rejections
    process.on("unhandledRejection", async (reason, promise) => {
      console.error("💥 Unhandled Rejection at:", promise, "reason:", reason);
      await this.shutdown();
      process.exit(1);
    });
  }

  private async shutdown() {
    console.log("🧹 Cleaning up application...");

    try {
      // Stop stats logging
      if (this.statsInterval) {
        clearInterval(this.statsInterval);
        this.statsInterval = null;
      }

      // Stop notification service
      console.log("🔔 Stopping notification service...");
      await this.notificationService.stop();

      // Disconnect WhatsApp bot
      console.log("📱 Disconnecting WhatsApp bot...");
      await this.whatsappBot.disconnect();

      console.log("✅ Application shutdown complete");
    } catch (error) {
      console.error("❌ Error during shutdown:", error);
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
    console.log(`🔄 Manually reprocessing ${limit} failed messages...`);
    await this.notificationService.reprocessFailedMessages(limit);
  }
}

// Create and start the application
async function main() {
  const app = new WhatsAppNotificationApp();

  try {
    await app.start();

    // Keep the process running
    process.stdin.resume();
  } catch (error) {
    console.error("💥 Application startup failed:", error);
    process.exit(1);
  }
}

// Start the application
main().catch((error) => {
  console.error("💥 Fatal error:", error);
  process.exit(1);
});
