export interface Job {
	id: string;
	type: string;
	payload: string;
	status: string;
	attempts: number;
	max_attempts: number;
	last_error: string | null;
	run_at: number;
	created_at: number;
	updated_at: number;
}

export interface CreateJobInput {
	type: string;
	payload?: Record<string, unknown>;
	runAt?: number;
}

// Create a new job in the queue
export async function createJob(
	db: D1Database,
	input: CreateJobInput,
): Promise<string> {
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	const runAt = input.runAt || now;
	const payload = JSON.stringify(input.payload || {});

	await db
		.prepare(
			"INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, run_at, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, 3, ?, ?, ?)",
		)
		.bind(id, input.type, payload, runAt, now, now)
		.run();

	return id;
}

// Get pending jobs that are ready to run
export async function getPendingJobs(
	db: D1Database,
	limit = 10,
): Promise<Job[]> {
	const now = Math.floor(Date.now() / 1000);

	const { results } = await db
		.prepare(
			"SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC LIMIT ?",
		)
		.bind(now, limit)
		.all<Job>();

	return results;
}

// Process a single job
// Add your own processing logic in the switch statement below
export async function processJob(db: D1Database, job: Job): Promise<void> {
	const now = Math.floor(Date.now() / 1000);

	try {
		// Mark as running
		await db
			.prepare(
				"UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?",
			)
			.bind(now, job.id)
			.run();

		// Process based on job type
		const payload = JSON.parse(job.payload);

		switch (job.type) {
			case "example-task":
				// Replace with your own logic
				console.log(`Processing example task: ${JSON.stringify(payload)}`);
				break;

			default:
				// Webhook-created jobs and other types
				if (job.type.startsWith("webhook.")) {
					console.log(`Processing webhook job: ${job.type}`, payload);
				} else {
					console.log(`Unknown job type: ${job.type}`);
				}
				break;
		}

		// Mark as completed
		await db
			.prepare(
				"UPDATE jobs SET status = 'completed', updated_at = ? WHERE id = ?",
			)
			.bind(Math.floor(Date.now() / 1000), job.id)
			.run();
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);

		// Mark as failed
		await db
			.prepare(
				"UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
			)
			.bind(errorMessage, Math.floor(Date.now() / 1000), job.id)
			.run();
	}
}

// Retry failed jobs that haven't exceeded max attempts
// Uses exponential backoff: 2^attempts * 60 seconds
export async function retryFailedJobs(db: D1Database): Promise<number> {
	const now = Math.floor(Date.now() / 1000);

	const { results } = await db
		.prepare(
			"SELECT id, attempts FROM jobs WHERE status = 'failed' AND attempts < max_attempts",
		)
		.all<{ id: string; attempts: number }>();

	let retried = 0;

	for (const job of results) {
		// Exponential backoff: 2^attempts * 60 seconds
		const backoffSeconds = Math.pow(2, job.attempts) * 60;
		const nextRunAt = now + backoffSeconds;

		await db
			.prepare(
				"UPDATE jobs SET status = 'pending', run_at = ?, updated_at = ? WHERE id = ?",
			)
			.bind(nextRunAt, now, job.id)
			.run();

		retried++;
	}

	return retried;
}
