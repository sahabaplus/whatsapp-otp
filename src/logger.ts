import { mkdirSync } from "node:fs";
import path from "node:path";
import type { TransportMultiOptions, TransportTargetOptions } from "pino";

/**
 * Creates pino transports configuration with:
 * 1. Pretty console output (development, only if stdout is TTY)
 * 2. File transport (if LOG_PATH is provided)
 */
export const createPinoTransports = (): TransportMultiOptions => {
  const isProduction = process.env.NODE_ENV === "production";
  const defaultLogLevel = isProduction ? "info" : "debug";
  const logLevel = process.env.LOG_LEVEL ?? defaultLogLevel;
  // If stdout is not a TTY (e.g., piped to pino-pretty), output raw JSON
  const isStdoutTTY = process.stdout.isTTY ?? false;

  // We only keep the File transport (optional) and the Console transport
  const transports: TransportTargetOptions[] = [
    // In Production, we want raw JSON (fastest, machine readable)
    // In Dev, we want Pretty logs only if stdout is a TTY (not piped)
    // If piped (like to pino-pretty), output raw JSON and let the pipe handle formatting
    ...(isProduction || !isStdoutTTY
      ? [{ target: "pino/file", options: { destination: 1 } }] // 1 = STDOUT
      : createPrettyTransport(isProduction, logLevel)),
    ...createFileTransport(logLevel),
  ];

  return { targets: transports };
};

/**
 * Creates pretty console transport for development and optional production use
 */
const createPrettyTransport = (
  isProduction: boolean,
  logLevel: string
): TransportTargetOptions[] => {
  if (isProduction && process.env.ENABLE_PRETTY_LOGS !== "true") return [];

  return [
    {
      target: "pino-pretty",
      level: logLevel,
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
        singleLine: false,
      },
    },
  ];
};

/**
 * Creates file transport if LOG_PATH is configured
 */
const createFileTransport = (logLevel: string): TransportTargetOptions[] => {
  const logPath = process.env.LOG_PATH;
  if (!logPath) return [];

  const logsDir = path.resolve(logPath);

  try {
    mkdirSync(logsDir, { recursive: true });
  } catch {
    // Directory might already exist or error creating it, mkdir option will handle it
  }

  const logFileName = `app-${new Date().toISOString().split("T")[0]}.log`;
  const logFilePath = path.join(logsDir, logFileName);

  return [
    {
      target: "pino/file",
      level: logLevel,
      options: {
        destination: logFilePath,
        mkdir: true,
      },
    },
  ];
};
