/**
 * Sending a reminder.
 *
 * Twilio is reached over its REST API rather than through its SDK: the SDK is
 * a large dependency for two endpoints, and the interesting part of sending an
 * SMS is the error handling, which the SDK does not help with.
 */

import type { Logger } from "@/lib/logger";

export interface Message {
  to: string;
  body: string;
  /** Deduplicates at the provider where it supports it. */
  idempotencyKey?: string;
}

export interface SendResult {
  /** The provider's id, so a delivery report can be matched back. */
  messageId: string;
}

/**
 * Whether a failure is worth trying again.
 *
 * The distinction matters more than it looks. Retrying a permanent failure —
 * an invalid number, a blocked recipient — burns the retry budget and
 * eventually looks like an outage. Not retrying a transient one loses the
 * reminder.
 */
export class SendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = "SendError";
  }
}

export interface MessageSender {
  readonly channel: "sms" | "email";
  send(message: Message): Promise<SendResult>;
}

/** Twilio error codes that mean "this will never work". */
const PERMANENT_TWILIO_CODES = new Set([
  "21211", // invalid 'To' number
  "21214", // 'To' number is not mobile
  "21408", // not permitted to send to this region
  "21610", // recipient has unsubscribed
  "21612", // unreachable via SMS
  "21614", // not a valid mobile number
]);

export class TwilioSender implements MessageSender {
  readonly channel = "sms" as const;

  constructor(
    private readonly config: {
      accountSid: string;
      authToken: string;
      from: string;
      baseUrl?: string;
    },
    private readonly logger: Pick<Logger, "warn">,
  ) {}

  async send(message: Message): Promise<SendResult> {
    const base = this.config.baseUrl ?? "https://api.twilio.com";
    const url = `${base}/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`;
    const body = new URLSearchParams({
      To: message.to,
      From: this.config.from,
      Body: message.body,
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${this.config.accountSid}:${this.config.authToken}`,
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
          ...(message.idempotencyKey
            ? { "I-Twilio-Idempotency-Token": message.idempotencyKey }
            : {}),
        },
        body,
        // A hung request would hold a worker slot indefinitely.
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      // A network failure or a timeout is transient by definition.
      throw new SendError(
        `could not reach the SMS provider: ${String(err)}`,
        true,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      const code = extractCode(text);
      const retryable =
        response.status >= 500 || response.status === 429
          ? true
          : !(code && PERMANENT_TWILIO_CODES.has(code));
      // The body can contain the recipient's number, so it is not logged.
      this.logger.warn(
        { status: response.status, code, retryable },
        "SMS provider rejected a message",
      );
      throw new SendError(
        `the SMS provider returned ${response.status}${code ? ` (${code})` : ""}`,
        retryable,
        code,
      );
    }

    const parsed = JSON.parse(text) as { sid?: unknown };
    if (typeof parsed.sid !== "string") {
      throw new SendError("the SMS provider returned no message id", true);
    }
    return { messageId: parsed.sid };
  }
}

function extractCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return parsed.code === undefined ? undefined : String(parsed.code);
  } catch {
    return undefined;
  }
}

/** Writes to the log instead of sending. The default in development. */
export class LoggingSender implements MessageSender {
  readonly sent: Message[] = [];

  constructor(
    readonly channel: "sms" | "email",
    private readonly logger: Pick<Logger, "info">,
  ) {}

  async send(message: Message): Promise<SendResult> {
    this.sent.push(message);
    this.logger.info(
      { channel: this.channel, to: redact(message.to) },
      "reminder (not sent)",
    );
    return { messageId: `local-${this.sent.length}` };
  }
}

/** Keeps the last four digits, so a log is useful without being personal data. */
export function redact(destination: string): string {
  if (destination.includes("@")) {
    const [name, domain] = destination.split("@");
    return `${(name ?? "").slice(0, 2)}***@${domain ?? ""}`;
  }
  return `***${destination.slice(-4)}`;
}
