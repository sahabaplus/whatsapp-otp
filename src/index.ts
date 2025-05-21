import {
  NotificationEvents,
  NotificationService,
  type INotification,
} from "./notification_service";
import { WhatsappBot } from "./whatsapp_bot";

async function main() {
  const service = new WhatsappBot();
  await service.init();

  const notificationService = new NotificationService();
  notificationService.start();

  // Event handlers
  notificationService.on(
    NotificationEvents.MESSAGE_RECEIVED,
    (notification: INotification) => {
      console.log("Sending message:", notification);
      service.sendMessage({
        phoneNumber: notification.phoneNumber,
        message: notification.message,
      });
    }
  );

  notificationService.on(NotificationEvents.PROCESSING_ERROR, (error) => {
    console.error("Error processing notification:", error);
  });

  notificationService.on(NotificationEvents.SERVICE_ERROR, (error) => {
    console.error("Service error:", error);
  });

  notificationService.on(NotificationEvents.SERVICE_STARTED, () => {
    console.log("Notification service started");
  });

  notificationService.on(NotificationEvents.SERVICE_STOPPED, () => {
    console.log("Notification service stopped");
  });

  process.on("SIGTERM", async () => {
    console.log("Received SIGTERM. Cleaning up...");
    await notificationService.stop();
    process.exit(0);
  });
}

main();
