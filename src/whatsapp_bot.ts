// whatsapp_bot.ts
import makeWASocket, {
  delay,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  type AnyMessageContent,
  type WAMessageContent,
  type WAMessageKey,
  downloadMediaMessage,
  getContentType,
} from "@whiskeysockets/baileys";
import P from "pino";
import NodeCache from "node-cache";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";

interface SendMessageParams {
  phoneNumber: string;
  message: string;
  options?: Partial<AnyMessageContent>;
}

interface SendMediaParams {
  phoneNumber: string;
  media: Buffer | string; // Buffer for file data or string for file path
  mediaType: "image" | "video" | "document" | "audio";
  caption?: string;
  fileName?: string;
  mimetype?: string;
}

export class WhatsappBot {
  private sock: ReturnType<typeof makeWASocket> | undefined = undefined;
  private sessionsCount = 0;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private isConnecting = false;
  private connectionPromise: Promise<void> | null = null;

  // Simple message store for getMessage callback
  private messageStore = new Map<string, WAMessageContent>();

  private readonly logger = P(
    {
      timestamp: () => `,"time":"${new Date().toJSON()}"`,
      level: "info",
    },
    P.destination("./wa-logs.txt")
  );

  constructor() {
    // Setup periodic cleanup of old messages from store
    setInterval(() => {
      // Keep only last 1000 messages to prevent memory issues
      if (this.messageStore.size > 1000) {
        const entries = Array.from(this.messageStore.entries());
        const toKeep = entries.slice(-500); // Keep last 500
        this.messageStore.clear();
        toKeep.forEach(([key, value]) => this.messageStore.set(key, value));
        console.log(
          `🧹 Cleaned up message store, kept ${toKeep.length} messages`
        );
      }
    }, 60000); // Cleanup every minute
  }

  async init(): Promise<void> {
    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise;
    }

    this.isConnecting = true;
    this.connectionPromise = this.createConnection();

    try {
      await this.connectionPromise;
    } finally {
      this.isConnecting = false;
      this.connectionPromise = null;
    }
  }

  private async createConnection(): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
      try {
        const { state, saveCreds } = await useMultiFileAuthState(
          "baileys_auth_info"
        );
        const { version, isLatest } = await fetchLatestBaileysVersion();

        console.log(`Using WA v${version.join(".")}, isLatest: ${isLatest}`);

        const sock = makeWASocket({
          version,
          logger: this.logger.child({ module: "socket" }),
          printQRInTerminal: true,
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, this.logger),
          },
          msgRetryCounterCache: new NodeCache(),
          generateHighQualityLinkPreview: true,
          syncFullHistory: false,
          getMessage: this.getMessage.bind(this),
          // Add connection options for better stability
          connectTimeoutMs: 60_000,
          defaultQueryTimeoutMs: 60_000,
          keepAliveIntervalMs: 10_000,
          // Browser config
          browser: ["WhatsApp Bot", "Chrome", "1.0.0"],
          // Retry configuration
          retryRequestDelayMs: 250,
          maxMsgRetryCount: 5,
        });

        this.sock = sock;

        let isResolved = false;

        sock.ev.process(async (events) => {
          // Handle connection updates
          if (events["connection.update"]) {
            const update = events["connection.update"];
            const { connection, lastDisconnect, qr } = update;

            console.log("Connection update:", update);

            if (qr) {
              console.log("QR Code received - scan to connect");
            }

            if (connection === "close") {
              const shouldReconnect = this.shouldReconnect(lastDisconnect);

              if (
                shouldReconnect &&
                this.reconnectAttempts < this.maxReconnectAttempts
              ) {
                this.reconnectAttempts++;
                console.log(
                  `Reconnecting... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
                );

                // Wait before reconnecting with exponential backoff
                const delayMs = Math.min(
                  1000 * Math.pow(2, this.reconnectAttempts - 1),
                  30000
                );
                await new Promise((resolve) => setTimeout(resolve, delayMs));

                if (!isResolved) {
                  reject(new Error("Connection closed, will retry"));
                  return;
                }

                this.init().catch(console.error);
              } else {
                console.log(
                  "Connection closed permanently or max retries reached"
                );
                if (!isResolved) {
                  reject(new Error("Connection failed permanently"));
                }
              }
            }

            if (connection === "open") {
              console.log("✅ WhatsApp connection established successfully");
              this.reconnectAttempts = 0; // Reset counter on successful connection

              if (!isResolved) {
                isResolved = true;
                resolve();
              }
            }
          }

          // Save credentials when updated
          if (events["creds.update"]) {
            await saveCreds();
          }

          // Handle incoming calls
          if (events.call) {
            console.log("Incoming call:", events.call);
          }

          // Handle incoming messages (for logging/processing and store in our simple store)
          if (events["messages.upsert"]) {
            const { messages } = events["messages.upsert"];
            messages.forEach((msg) => {
              // Store message for getMessage callback
              if (msg.key?.id && msg.message) {
                const messageKey = `${msg.key.remoteJid}:${msg.key.id}`;
                this.messageStore.set(messageKey, msg.message);
              }

              if (!msg.key.fromMe) {
                console.log("Received message:", {
                  from: msg.key.remoteJid,
                  messageType: getContentType(msg.message || undefined),
                  timestamp: msg.messageTimestamp
                    ? new Date(Number(msg.messageTimestamp) * 1000)
                    : new Date(),
                });
              }
            });
          }
        });

        // Set a timeout for the initial connection
        const connectionTimeout = setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            reject(new Error("Connection timeout"));
          }
        }, 120_000); // 2 minutes timeout

        // Clear timeout if connection resolves/rejects
        const originalResolve = resolve;
        const originalReject = reject;

        resolve = (...args) => {
          clearTimeout(connectionTimeout);
          originalResolve(...args);
        };

        reject = (...args) => {
          clearTimeout(connectionTimeout);
          originalReject(...args);
        };
      } catch (error) {
        console.error("Error creating connection:", error);
        reject(error);
      }
    });
  }

  private shouldReconnect(lastDisconnect: any): boolean {
    const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;

    // Don't reconnect if logged out
    if (reason === DisconnectReason.loggedOut) {
      console.log("Device logged out, manual scan required");
      return false;
    }

    // Don't reconnect for these specific errors
    const noReconnectReasons = [
      DisconnectReason.badSession,
      // sessionReplaced doesn't exist in newer versions
    ];

    if (noReconnectReasons.includes(reason)) {
      console.log("Session invalid, manual intervention required");
      return false;
    }

    return true;
  }

  private async getMessage(
    key: WAMessageKey
  ): Promise<WAMessageContent | undefined> {
    // Try to get message from our simple store
    const messageKey = `${key.remoteJid}:${key.id}`;
    const storedMessage = this.messageStore.get(messageKey);

    if (storedMessage) {
      return storedMessage;
    }

    // Return empty message if not found
    return proto.Message.fromObject({});
  }

  public async sendMessage(params: SendMessageParams): Promise<boolean> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!this.sock) {
          await this.ensureConnection();
        }

        // Normalize phone number format
        const phoneNumber = this.normalizePhoneNumber(params.phoneNumber);

        console.log(`Sending message (attempt ${attempt}/${maxRetries}):`, {
          to: phoneNumber,
          messageLength: params.message.length,
        });

        const messageContent = {
          text: params.message,
          ...params.options,
        };

        const response = await this.sock!.sendMessage(
          `${phoneNumber}@s.whatsapp.net`,
          messageContent
        );

        this.removeSessions();

        const success = response?.status !== proto.WebMessageInfo.Status.ERROR;

        if (success) {
          console.log("✅ Message sent successfully");
          return true;
        } else {
          throw new Error(`Message failed with status: ${response?.status}`);
        }
      } catch (error: any) {
        lastError = error;
        console.error(
          `❌ Send message attempt ${attempt} failed:`,
          error.message
        );

        // If it's a timeout or connection error, wait and retry
        if (attempt < maxRetries && this.isRetryableError(error)) {
          const delayMs = 1000 * attempt; // Progressive delay
          console.log(`Waiting ${delayMs}ms before retry...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));

          // Reset connection for timeout errors
          if (error.message?.includes("Timed Out")) {
            this.sock = undefined;
          }
          continue;
        }

        break;
      }
    }

    console.error("❌ All send attempts failed:", lastError?.message);
    return false;
  }

  public async sendMedia(params: SendMediaParams): Promise<boolean> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!this.sock) {
          await this.ensureConnection();
        }

        const phoneNumber = this.normalizePhoneNumber(params.phoneNumber);

        console.log(
          `Sending ${params.mediaType} (attempt ${attempt}/${maxRetries}):`,
          {
            to: phoneNumber,
            fileName: params.fileName,
          }
        );

        let mediaBuffer: Buffer;

        if (typeof params.media === "string") {
          // If media is a file path
          mediaBuffer = await fs.promises.readFile(params.media);
        } else {
          // If media is already a buffer
          mediaBuffer = params.media;
        }

        let messageContent: AnyMessageContent;

        switch (params.mediaType) {
          case "image":
            messageContent = {
              image: mediaBuffer,
              caption: params.caption,
              mimetype: params.mimetype || "image/jpeg",
            };
            break;

          case "video":
            messageContent = {
              video: mediaBuffer,
              caption: params.caption,
              mimetype: params.mimetype || "video/mp4",
            };
            break;

          case "document":
            messageContent = {
              document: mediaBuffer,
              fileName: params.fileName || "document",
              mimetype: params.mimetype || "application/pdf",
            };
            break;

          case "audio":
            messageContent = {
              audio: mediaBuffer,
              mimetype: params.mimetype || "audio/mpeg",
            };
            break;

          default:
            throw new Error(`Unsupported media type: ${params.mediaType}`);
        }

        const response = await this.sock!.sendMessage(
          `${phoneNumber}@s.whatsapp.net`,
          messageContent
        );

        this.removeSessions();

        const success = response?.status !== proto.WebMessageInfo.Status.ERROR;

        if (success) {
          console.log(`✅ ${params.mediaType} sent successfully`);
          return true;
        } else {
          throw new Error(`Media failed with status: ${response?.status}`);
        }
      } catch (error: any) {
        lastError = error;
        console.error(
          `❌ Send ${params.mediaType} attempt ${attempt} failed:`,
          error.message
        );

        if (attempt < maxRetries && this.isRetryableError(error)) {
          const delayMs = 1000 * attempt;
          console.log(`Waiting ${delayMs}ms before retry...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));

          if (error.message?.includes("Timed Out")) {
            this.sock = undefined;
          }
          continue;
        }

        break;
      }
    }

    console.error(
      `❌ All ${params.mediaType} send attempts failed:`,
      lastError?.message
    );
    return false;
  }

  private normalizePhoneNumber(phoneNumber: string): string {
    // Remove any non-numeric characters except +
    let normalized = phoneNumber.replace(/[^\d+]/g, "");

    // Remove leading + if present
    if (normalized.startsWith("+")) {
      normalized = normalized.substring(1);
    }

    // Ensure it starts with country code (assuming Saudi Arabia if not present)
    if (!normalized.startsWith("966") && normalized.length === 9) {
      normalized = "966" + normalized;
    }

    return normalized;
  }

  private isRetryableError(error: any): boolean {
    const retryableMessages = [
      "Timed Out",
      "Socket closed unexpectedly",
      "Connection closed",
      "ECONNRESET",
      "ENOTFOUND",
      "ETIMEDOUT",
    ];

    return retryableMessages.some(
      (msg) => error.message?.includes(msg) || error.toString().includes(msg)
    );
  }

  private async ensureConnection(): Promise<void> {
    if (!this.sock) {
      console.log("No active connection, initializing...");
      await this.init();
    }
  }

  async removeSessions() {
    if (this.sessionsCount++ < 10) return;
    this.sessionsCount = 0;

    try {
      const authPath = path.resolve(__dirname, "../baileys_auth_info/");
      const files = await fs.promises.readdir(authPath);

      const sessionFiles = files.filter(
        (file) => file.startsWith("session-") && file.endsWith(".json")
      );

      console.log(`Cleaning up ${sessionFiles.length} session files`);

      for (const file of sessionFiles) {
        try {
          await fs.promises.unlink(path.join(authPath, file));
          console.log(`Deleted session file: ${file}`);
        } catch (error) {
          console.error(`Failed to delete ${file}:`, error);
        }
      }
    } catch (error) {
      console.error("Session cleanup error:", error);
    }
  }

  public async disconnect(): Promise<void> {
    if (this.sock) {
      await this.sock.logout();
      this.sock = undefined;
    }

    // Clear message store
    this.messageStore.clear();
    console.log("🧹 Cleared message store");
  }

  public isConnected(): boolean {
    return !!this.sock;
  }

  public getConnectionInfo() {
    return {
      isConnected: this.isConnected(),
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
    };
  }
}
