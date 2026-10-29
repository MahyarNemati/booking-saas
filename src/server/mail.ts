import { appendFile } from "node:fs/promises";
import type { Logger } from "@/lib/logger";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: MailMessage): Promise<void> {
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, ...message }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`resend rejected message: ${res.status} ${await res.text()}`);
    }
  }
}

/** Development transport: logs the message and optionally appends it to a JSONL outbox. */
export class DevMailer implements Mailer {
  constructor(
    private readonly logger: Pick<Logger, "info">,
    private readonly outbox?: string,
  ) {}

  async send(message: MailMessage): Promise<void> {
    this.logger.info({ to: message.to, subject: message.subject, body: message.text }, "dev mail");
    if (this.outbox) {
      await appendFile(
        this.outbox,
        `${JSON.stringify({ at: new Date().toISOString(), ...message })}\n`,
      );
    }
  }
}

export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}
