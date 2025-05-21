import makeWASocket, {
  delay,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
  proto,
  useMultiFileAuthState,
  type AnyMessageContent,
  type WAMessageContent,
  type WAMessageKey,
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

export class WhatsappBot {
  private sock: ReturnType<typeof makeWASocket> | undefined = undefined;
  private sessionsCount = 0;
  private readonly logger = P(
    { timestamp: () => `,"time":"${new Date().toJSON()}"` },
    P.destination("./wa-logs.txt")
  );
  private readonly store: ReturnType<typeof makeInMemoryStore> | undefined =
    undefined;

  constructor() {}

  async init() {
    const promise = new Promise<void>(async (resolve) => {
      const { state, saveCreds } = await useMultiFileAuthState(
        "baileys_auth_info"
      );
      const { version, isLatest } = await fetchLatestBaileysVersion();
      console.log(`using WA v${version.join(".")}, isLatest: ${isLatest}`);

      const sock = makeWASocket({
        version,
        logger: this.logger,
        printQRInTerminal: true,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger),
        },
        msgRetryCounterCache: new NodeCache(),
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        getMessage: this.getMessage.bind(this),
      });

      this.sock = sock;

      this.store?.bind(sock.ev);
      let firstConnect = true;
      sock.ev.process(async (events) => {
        if (events["connection.update"]) {
          const update = events["connection.update"];
          const { connection, lastDisconnect } = update;
          if (connection === "close") {
            // reconnect if not logged out
            if (
              (lastDisconnect?.error as Boom)?.output?.statusCode !==
              DisconnectReason.loggedOut
            ) {
              await delay(1000);
              this.init();
            } else {
              console.log("Connection closed. You are logged out.");
            }
          }

          if (connection === "open" && firstConnect) {
            firstConnect = false;
            resolve();
          }
          console.log("connection update", update);
          if (update.qr) {
            console.log("QR code");
            console.log(update.qr);
          }
        }

        // credentials updated -- save them
        if (events["creds.update"]) {
          await saveCreds();
        }

        if (events.call) {
          console.log("recv call event", events.call);
        }
      });
    });

    return promise;
  }

  private async getMessage(
    key: WAMessageKey
  ): Promise<WAMessageContent | undefined> {
    if (this.store) {
      const msg = await this.store.loadMessage(key.remoteJid!, key.id!);
      return msg?.message || undefined;
    }

    // only if store is present
    return proto.Message.fromObject({});
  }

  public async sendMessage(params: SendMessageParams): Promise<boolean> {
    if (!this.sock) {
      throw new Error("Socket not initialized");
    }

    const response = await this.sock.sendMessage(
      `${params.phoneNumber}@s.whatsapp.net`,
      {
        text: params.message,
      }
    );

    this.removeSessions();

    return response?.status !== proto.WebMessageInfo.Status.ERROR;
  }

  async removeSessions() {
    if (this.sessionsCount++ < 10) return;
    this.sessionsCount = 0;
    try {
      const _path = path.resolve(__dirname, "../baileys_auth_info/");
      const a = await fs.promises.readdir(_path);
      console.log(a);
      a.filter(
        (file) => file.startsWith("session-") && file.endsWith(".json")
      ).forEach((file) => {
        console.log(file);
        fs.unlinkSync(path.join(_path, file));
      });
    } catch (e) {
      console.log(e);
    }
  }
}
