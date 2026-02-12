export interface EmailOptions {
	to: string;
	subject: string;
	html?: string;
	text?: string;
}

export interface SendResult {
	success: boolean;
	id?: string;
	error?: string;
}

export interface Env {
	RESEND_API_KEY: string;
	FROM_EMAIL?: string;
}

/**
 * Send an email via Resend API and log the result to D1.
 */
export async function sendEmail(
	env: Env,
	db: D1Database,
	opts: EmailOptions,
): Promise<SendResult> {
	const from = env.FROM_EMAIL || "onboarding@resend.dev";
	const id = crypto.randomUUID();

	try {
		const response = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.RESEND_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				from,
				to: opts.to,
				subject: opts.subject,
				html: opts.html,
				text: opts.text,
			}),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			let errorMessage: string;
			try {
				const parsed = JSON.parse(errorBody);
				errorMessage = parsed.message || parsed.error || errorBody;
			} catch {
				errorMessage = errorBody;
			}

			await db
				.prepare(
					"INSERT INTO email_log (id, to_address, from_address, subject, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.bind(id, opts.to, from, opts.subject, "failed", errorMessage, Math.floor(Date.now() / 1000))
				.run();

			return { success: false, error: errorMessage };
		}

		const data = (await response.json()) as { id: string };

		await db
			.prepare(
				"INSERT INTO email_log (id, to_address, from_address, subject, status, resend_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(id, opts.to, from, opts.subject, "sent", data.id, Math.floor(Date.now() / 1000))
			.run();

		return { success: true, id: data.id };
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : "Unknown error";

		await db
			.prepare(
				"INSERT INTO email_log (id, to_address, from_address, subject, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(id, opts.to, from, opts.subject, "failed", errorMessage, Math.floor(Date.now() / 1000))
			.run();

		return { success: false, error: errorMessage };
	}
}

/**
 * Welcome email template.
 */
export function welcomeEmail(to: string, name: string): EmailOptions {
	return {
		to,
		subject: `Welcome, ${name}!`,
		html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f6f9fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f9fc;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:40px;">
          <tr>
            <td>
              <h1 style="margin:0 0 16px;font-size:24px;color:#1a1a1a;">Welcome, ${name}!</h1>
              <p style="margin:0 0 24px;font-size:16px;line-height:1.5;color:#4a4a4a;">
                Thanks for signing up. We're glad to have you on board.
              </p>
              <p style="margin:0;font-size:16px;line-height:1.5;color:#4a4a4a;">
                If you have any questions, just reply to this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
	};
}

/**
 * Notification email template.
 */
export function notificationEmail(
	to: string,
	title: string,
	body: string,
): EmailOptions {
	return {
		to,
		subject: title,
		html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f6f9fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f9fc;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:40px;">
          <tr>
            <td>
              <h1 style="margin:0 0 16px;font-size:24px;color:#1a1a1a;">${title}</h1>
              <p style="margin:0;font-size:16px;line-height:1.5;color:#4a4a4a;">
                ${body}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
	};
}
