// whatsapp_bot.ts
import makeWASocket, {
  delay,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  type AnyMessageContent,
  downloadMediaMessage,
  getUrlInfo,
} from "@whiskeysockets/baileys";
import pino from "pino";
import NodeCache from "node-cache";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import axios from "axios";
import { URL } from "url";
import qrcode from "qrcode-terminal";
import { createPinoTransports } from "./logger";

interface SendMessageParams {
  phoneNumber: string;
  message: string;
  options?: Partial<AnyMessageContent>;
  enableLinkPreview?: boolean; // Enable automatic link preview generation (default: true)
}

interface SendMediaParams {
  phoneNumber: string;
  media: Buffer | string; // Buffer for file data, string for file path OR HTTPS URL
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

  // Idle timeout management
  private readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  private idleTimeout: NodeJS.Timeout | null = null;
  private lastActivityTime: number | null = null;

  private readonly logger = pino(
    {
      level:
        process.env.LOG_LEVEL ||
        (process.env.NODE_ENV === "production" ? "info" : "debug"),
    },
    pino.transport(createPinoTransports())
  );

  constructor() {
    // No message store cleanup needed - incoming messages are discarded
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

        this.logger.info(
          { version: version.join("."), isLatest },
          "Using WhatsApp version"
        );

        const sock = makeWASocket({
          version,
          logger: this.logger.child({ module: "socket" }),
          printQRInTerminal: true, // Keep this enabled for logout scenarios
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, this.logger),
          },
          msgRetryCounterCache: new NodeCache(),
          generateHighQualityLinkPreview: true,
          syncFullHistory: false,
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

            this.logger.debug({ connection, hasQr: !!qr }, "Connection update");

            if (qr) {
              const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(
                qr.trim()
              )}`;
              this.logger.info({ qr, qrUrl }, "QR Code received");
              console.log(qr);
              try {
                console.log(qrcode.generate(qr.trim(), { small: true }));
              } catch {
                //
              }
              console.log(
                "📱 QR Code received - scan with WhatsApp to authenticate:"
              );
              console.log("   1. Open WhatsApp on your phone");
              console.log("   2. Go to Settings > Linked Devices");
              console.log("   3. Tap 'Link a Device'");
              console.log("   4. Scan the QR code above");
              console.log(`   QR Code URL: ${qrUrl}`);
            }

            if (connection === "close") {
              const shouldReconnect = await this.shouldReconnect(
                lastDisconnect
              );

              if (
                shouldReconnect &&
                this.reconnectAttempts < this.maxReconnectAttempts
              ) {
                this.reconnectAttempts++;
                this.logger.info(
                  {
                    attempt: this.reconnectAttempts,
                    maxAttempts: this.maxReconnectAttempts,
                  },
                  "Reconnecting"
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

                this.init().catch((err) => {
                  this.logger.error({ err }, "Failed to reconnect");
                });
              } else {
                this.logger.warn(
                  {
                    reconnectAttempts: this.reconnectAttempts,
                    maxReconnectAttempts: this.maxReconnectAttempts,
                  },
                  "Connection closed permanently or max retries reached"
                );
                if (!isResolved) {
                  reject(new Error("Connection failed permanently"));
                }
              }
            }

            if (connection === "open") {
              this.logger.info("WhatsApp connection established successfully");
              this.reconnectAttempts = 0; // Reset counter on successful connection
              this.startIdleTimer(); // Start idle timeout after connection is established

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
            this.logger.info({ call: events.call }, "Incoming call");
          }

          // Incoming messages are discarded - no handling needed
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
        this.logger.error({ err: error }, "Error creating connection");
        reject(error);
      }
    });
  }

  private async shouldReconnect(lastDisconnect: any): Promise<boolean> {
    const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;

    // Handle logout - wipe auth and prepare for new QR scan
    if (reason === DisconnectReason.loggedOut) {
      this.logger.warn("Device logged out, wiping authentication store");
      await this.wipeAuthStore();
      this.logger.info("Please scan the QR code to re-authenticate");
      return true; // Allow reconnection with fresh auth
    }

    // Don't reconnect for these specific errors
    const noReconnectReasons = [
      DisconnectReason.badSession,
      // sessionReplaced doesn't exist in newer versions
    ];

    if (noReconnectReasons.includes(reason)) {
      this.logger.error(
        { reason },
        "Session invalid, manual intervention required"
      );
      return false;
    }

    return true;
  }

  // Helper method to download media from HTTPS URL using axios
  private async downloadFromUrl(url: string): Promise<Buffer> {
    try {
      this.logger.info({ url }, "Downloading media from URL");

      const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 30000, // 30 seconds timeout
        maxContentLength: 50 * 1024 * 1024, // 50MB max file size
        maxBodyLength: 50 * 1024 * 1024,
        headers: {
          "User-Agent": "WhatsApp-Bot/1.0.0",
          Accept: "*/*",
        },
      });

      const buffer = Buffer.from(response.data);
      this.logger.info(
        { url, size: buffer.length },
        "Downloaded media from URL"
      );

      return buffer;
    } catch (error: any) {
      if (error.code === "ECONNABORTED") {
        throw new Error("Download timeout - file took too long to download");
      } else if (error.response) {
        throw new Error(
          `HTTP ${error.response.status}: ${error.response.statusText}`
        );
      } else if (error.request) {
        throw new Error("Network error - could not reach the URL");
      } else {
        throw new Error(`Download failed: ${error.message}`);
      }
    }
  }

  // Helper method to wipe authentication store
  private async wipeAuthStore(): Promise<void> {
    try {
      const authPath = path.resolve("baileys_auth_info");

      // Check if auth directory exists
      if (!fs.existsSync(authPath)) {
        this.logger.info("Auth directory doesn't exist, nothing to wipe");
        return;
      }

      const files = await fs.promises.readdir(authPath);

      this.logger.info(
        { fileCount: files.length },
        "Wiping authentication files"
      );

      for (const file of files) {
        try {
          await fs.promises.unlink(path.join(authPath, file));
          this.logger.debug({ file }, "Deleted auth file");
        } catch (error) {
          this.logger.error({ err: error, file }, "Failed to delete auth file");
        }
      }

      // Remove the directory itself
      try {
        await fs.promises.rmdir(authPath);
        this.logger.info("Auth directory removed");
      } catch (error) {
        this.logger.error({ err: error }, "Failed to remove auth directory");
      }

      this.logger.info("Authentication store wiped successfully");
    } catch (error) {
      this.logger.error({ err: error }, "Error wiping auth store");
      throw error;
    }
  }
  private isUrl(str: string): boolean {
    try {
      const url = new URL(str);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  // Extract first URL from text message
  private extractUrlFromText(text: string): string | null {
    // Regular expression to match URLs
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    const matches = text.match(urlRegex);
    return matches && matches.length > 0 ? matches[0] : null;
  }

  // Generate link preview for a URL
  private async generateLinkPreview(url: string): Promise<any | null> {
    try {
      if (!this.sock) {
        this.logger.warn("No socket connection for link preview");
        return null;
      }

      this.logger.info({ url }, "Generating link preview");

      const linkPreview = await getUrlInfo(url, {
        thumbnailWidth: 1024,
        fetchOpts: {
          timeout: 5000,
        },
        uploadImage: this.sock.waUploadToServer,
      });

      this.logger.info({ url }, "Link preview generated successfully");
      return linkPreview;
    } catch (error: any) {
      this.logger.error({ err: error, url }, "Failed to generate link preview");
      // Don't throw - we'll send the message without preview
      return null;
    }
  }

  // Helper method to get media buffer from various sources
  private async getMediaBuffer(media: Buffer | string): Promise<Buffer> {
    if (Buffer.isBuffer(media)) {
      return media;
    }

    // Check if it's a URL
    if (this.isUrl(media)) {
      this.logger.info({ url: media }, "Downloading media from URL");
      return await this.downloadFromUrl(media);
    }

    // Otherwise, treat as local file path
    return await fs.promises.readFile(media);
  }

  public async sendMessage(params: SendMessageParams): Promise<boolean> {
    const maxRetries = 3;
    let lastError: Error | null = null;
    // Normalize phone number format once
    const phoneNumber = this.normalizePhoneNumber(params.phoneNumber);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Ensure connection is active before sending
        await this.ensureConnection();

        this.logger.info(
          {
            attempt,
            maxRetries,
            to: phoneNumber,
            messageLength: params.message.length,
          },
          "Sending message"
        );

        // Build message content
        const messageContent: any = {
          text: params.message,
          ...params.options,
        };

        // Generate link preview if enabled (default: true) and URL is found
        const enableLinkPreview = params.enableLinkPreview !== false;
        const existingLinkPreview = (params.options as any)?.linkPreview;

        if (enableLinkPreview && !existingLinkPreview) {
          const url = this.extractUrlFromText(params.message);
          if (url) {
            const linkPreview = await this.generateLinkPreview(url);
            if (linkPreview) {
              messageContent.linkPreview = linkPreview;
            }
          }
        }

        const response = await this.sock!.sendMessage(
          `${phoneNumber}@s.whatsapp.net`,
          messageContent
        );

        this.removeSessions();

        const success = response?.status !== proto.WebMessageInfo.Status.ERROR;

        if (success) {
          this.logger.info({ to: phoneNumber }, "Message sent successfully");
          this.resetIdleTimer(); // Reset idle timer on successful message send
          return true;
        } else {
          throw new Error(`Message failed with status: ${response?.status}`);
        }
      } catch (error: any) {
        lastError = error;
        this.logger.error(
          { err: error, attempt, maxRetries, to: phoneNumber },
          "Send message attempt failed"
        );

        // If it's a timeout or connection error, wait and retry
        if (attempt < maxRetries && this.isRetryableError(error)) {
          const delayMs = 1000 * attempt; // Progressive delay
          this.logger.debug({ delayMs }, "Waiting before retry");
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

    this.logger.error(
      { err: lastError, to: params.phoneNumber },
      "All send attempts failed"
    );
    return false;
  }

  public async sendMedia(params: SendMediaParams): Promise<boolean> {
    const maxRetries = 3;
    let lastError: Error | null = null;
    // Normalize phone number format once
    const phoneNumber = this.normalizePhoneNumber(params.phoneNumber);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Ensure connection is active before sending
        await this.ensureConnection();

        this.logger.info(
          {
            attempt,
            maxRetries,
            mediaType: params.mediaType,
            to: phoneNumber,
            fileName: params.fileName,
            mediaSource:
              typeof params.media === "string"
                ? this.isUrl(params.media)
                  ? "URL"
                  : "File Path"
                : "Buffer",
          },
          "Sending media"
        );

        // Get media buffer from URL, file path, or existing buffer
        const mediaBuffer = await this.getMediaBuffer(params.media);

        this.logger.debug(
          { mediaType: params.mediaType, size: mediaBuffer.length },
          "Media buffer prepared"
        );

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
          this.logger.info(
            { mediaType: params.mediaType, to: phoneNumber },
            "Media sent successfully"
          );
          this.resetIdleTimer(); // Reset idle timer on successful media send
          return true;
        } else {
          throw new Error(`Media failed with status: ${response?.status}`);
        }
      } catch (error: any) {
        lastError = error;
        this.logger.error(
          {
            err: error,
            attempt,
            maxRetries,
            mediaType: params.mediaType,
            to: phoneNumber,
          },
          "Send media attempt failed"
        );

        if (attempt < maxRetries && this.isRetryableError(error)) {
          const delayMs = 1000 * attempt;
          this.logger.debug({ delayMs }, "Waiting before retry");
          await new Promise((resolve) => setTimeout(resolve, delayMs));

          if (error.message?.includes("Timed Out")) {
            this.sock = undefined;
          }
          continue;
        }

        break;
      }
    }

    this.logger.error(
      {
        err: lastError,
        mediaType: params.mediaType,
        to: params.phoneNumber,
      },
      "All send media attempts failed"
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
      "Download timeout",
      "Network error",
    ];

    return retryableMessages.some(
      (msg) => error.message?.includes(msg) || error.toString().includes(msg)
    );
  }

  private async ensureConnection(): Promise<void> {
    // If already connecting, wait for that connection
    if (this.isConnecting && this.connectionPromise) {
      this.logger.debug("Connection already in progress, waiting");
      await this.connectionPromise;
      return;
    }

    // Check if we need to reconnect
    if (!this.sock) {
      this.logger.info("No active connection, reconnecting for new message");
      await this.init();
      // Idle timer will be started automatically when connection opens
      this.logger.info("Reconnection complete, ready to send message");
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

      this.logger.info(
        { sessionFileCount: sessionFiles.length },
        "Cleaning up session files"
      );

      for (const file of sessionFiles) {
        try {
          await fs.promises.unlink(path.join(authPath, file));
          this.logger.debug({ file }, "Deleted session file");
        } catch (error) {
          this.logger.error(
            { err: error, file },
            "Failed to delete session file"
          );
        }
      }
    } catch (error) {
      this.logger.error({ err: error }, "Session cleanup error");
    }
  }

  public async disconnect(): Promise<void> {
    try {
      this.clearIdleTimer(); // Clear idle timer on disconnect

      if (this.sock) {
        this.logger.info("Disconnecting WhatsApp bot");
        // Don't call logout() during normal disconnect to avoid wiping auth
        // Just close the socket gracefully
        this.sock.ws?.close();
        this.sock = undefined;
        this.logger.info("WhatsApp bot disconnected");
      }
    } catch (error) {
      this.logger.error({ err: error }, "Error during disconnect");
      // Don't throw - we want disconnect to always succeed
    }
  }

  public async forceLogout(): Promise<void> {
    try {
      if (this.sock) {
        this.logger.warn("Forcing logout and wiping auth store");
        await this.sock.logout();
        this.sock = undefined;
      }
      await this.wipeAuthStore();
      this.logger.info("Forced logout completed");
    } catch (error) {
      this.logger.error({ err: error }, "Error during force logout");
      // Still try to wipe auth store even if logout fails
      try {
        await this.wipeAuthStore();
      } catch (wipeError) {
        this.logger.error({ err: wipeError }, "Failed to wipe auth store");
      }
    }
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

  // Idle timeout management methods
  private startIdleTimer(): void {
    this.resetIdleTimer();
    this.logger.info({ timeoutMs: this.IDLE_TIMEOUT_MS }, "Idle timer started");
  }

  private resetIdleTimer(): void {
    // Clear existing timeout
    this.clearIdleTimer();

    // Set new activity time
    this.lastActivityTime = Date.now();

    // Set new timeout to disconnect after idle period
    this.idleTimeout = setTimeout(() => {
      this.logger.info("Connection idle for 5 minutes, closing connection");
      this.disconnect().catch((error) => {
        this.logger.error(
          { err: error },
          "Error during idle timeout disconnect"
        );
      });
    }, this.IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }
    this.lastActivityTime = null;
  }
}
