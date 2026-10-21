import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SESv2Client } from '@aws-sdk/client-sesv2';
import type { Mailer, OutgoingEmail } from '@closed-loop/core';

/** Amazon SES (v2 API). In the SES sandbox every recipient must be a verified identity. */
// The SES client is loaded on first send, so MCP cold starts do not pay for it.
export class SesMailer implements Mailer {
  private client?: SESv2Client;

  constructor(
    private readonly from: string,
    private readonly configurationSet?: string,
  ) {}

  async send(email: OutgoingEmail) {
    const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    this.client ??= new SESv2Client({});
    const res = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: `Closed Loop check-ins <${this.from}>`,
        Destination: { ToAddresses: [email.to] },
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: email.text, Charset: 'UTF-8' }, Html: { Data: email.html, Charset: 'UTF-8' } },
          },
        },
        EmailTags: [
          { Name: 'kind', Value: email.kind },
          { Name: 'household', Value: email.householdId.replace(/[^A-Za-z0-9_-]/g, '_') },
        ],
        ConfigurationSetName: this.configurationSet,
      }),
    );
    return { messageId: res.MessageId ?? 'unknown' };
  }
}

/** Local run mode: writes each email to ./out/emails as HTML and logs a one-line summary. */
export class FileMailer implements Mailer {
  private n = 0;
  constructor(private readonly dir: string) {}

  async send(email: OutgoingEmail) {
    await mkdir(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(this.dir, `${stamp}-${++this.n}-${email.kind}-${email.to.replace(/[^a-z0-9]/gi, '_')}.html`);
    const header = `<!-- To: ${email.to}\n     Subject: ${email.subject} -->\n`;
    await writeFile(file, header + email.html, 'utf8');
    console.log(`[email] to=${email.to} subject="${email.subject}" -> ${file}`);
    return { messageId: file };
  }
}

/** Keeps sent emails in memory so the local simulator can show them in its event feed. */
export class RecordingMailer implements Mailer {
  readonly sent: Array<OutgoingEmail & { at: string; messageId: string }> = [];
  constructor(private readonly inner: Mailer) {}

  async send(email: OutgoingEmail) {
    const r = await this.inner.send(email);
    this.sent.unshift({ ...email, at: new Date().toISOString(), messageId: r.messageId });
    this.sent.length = Math.min(this.sent.length, 50);
    return r;
  }
}
