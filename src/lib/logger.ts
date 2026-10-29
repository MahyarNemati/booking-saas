import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "saas-starter" },
  redact: {
    paths: ["*.password", "*.token", "*.apiKey", "*.authorization", "*.secret"],
    censor: "[redacted]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
