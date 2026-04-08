import { describe, expect, test } from "bun:test";
import {
	formatChannelContent,
	shouldEmitChannelNotification,
} from "../src/mcp/channel/log-subscriber.ts";

function makeEvent(overrides: {
	outcome?: string | null;
	logs?: Array<{ ts: number | null; level: string | null; message: unknown[] }>;
	exceptions?: Array<{ ts: number | null; name: string | null; message: string | null }>;
	request?: { method?: string; url?: string } | null;
}) {
	return {
		type: "event" as const,
		ts: Date.now(),
		outcome: overrides.outcome ?? "ok",
		request: overrides.request ?? null,
		logs: overrides.logs ?? [],
		exceptions: overrides.exceptions ?? [],
	};
}

describe("shouldEmitChannelNotification", () => {
	test("returns true for events with exceptions", () => {
		const event = makeEvent({
			exceptions: [{ ts: Date.now(), name: "TypeError", message: "Cannot read property 'id'" }],
		});
		expect(shouldEmitChannelNotification(event)).toBe(true);
	});

	test("returns true for events with error-level logs", () => {
		const event = makeEvent({
			logs: [{ ts: Date.now(), level: "error", message: ["D1_ERROR: no such column: priority"] }],
		});
		expect(shouldEmitChannelNotification(event)).toBe(true);
	});

	test("returns true for exception outcome", () => {
		const event = makeEvent({ outcome: "exception" });
		expect(shouldEmitChannelNotification(event)).toBe(true);
	});

	test("returns true for exceededCpu outcome", () => {
		const event = makeEvent({ outcome: "exceededCpu" });
		expect(shouldEmitChannelNotification(event)).toBe(true);
	});

	test("returns true for exceededMemory outcome", () => {
		const event = makeEvent({ outcome: "exceededMemory" });
		expect(shouldEmitChannelNotification(event)).toBe(true);
	});

	test("returns true for exceededWallTime outcome", () => {
		const event = makeEvent({ outcome: "exceededWallTime" });
		expect(shouldEmitChannelNotification(event)).toBe(true);
	});

	test("returns true for scriptNotFound outcome", () => {
		const event = makeEvent({ outcome: "scriptNotFound" });
		expect(shouldEmitChannelNotification(event)).toBe(true);
	});

	test("returns false for normal ok events", () => {
		const event = makeEvent({
			outcome: "ok",
			logs: [{ ts: Date.now(), level: "log", message: ["Request handled"] }],
		});
		expect(shouldEmitChannelNotification(event)).toBe(false);
	});

	test("returns false for empty events", () => {
		const event = makeEvent({});
		expect(shouldEmitChannelNotification(event)).toBe(false);
	});

	test("returns false for warn-level logs without errors", () => {
		const event = makeEvent({
			logs: [{ ts: Date.now(), level: "warn", message: ["Deprecation warning"] }],
		});
		expect(shouldEmitChannelNotification(event)).toBe(false);
	});
});

describe("formatChannelContent", () => {
	test("formats exception with name and message", () => {
		const event = makeEvent({
			outcome: "exception",
			exceptions: [{ ts: Date.now(), name: "TypeError", message: "Cannot read property 'id'" }],
		});
		const { content, meta } = formatChannelContent(event);
		expect(content).toContain("TypeError: Cannot read property 'id'");
		expect(meta.event).toBe("exception");
	});

	test("formats error logs", () => {
		const event = makeEvent({
			logs: [
				{ ts: Date.now(), level: "error", message: ["D1_ERROR:", "no such column: priority"] },
			],
		});
		const { content, meta } = formatChannelContent(event);
		expect(content).toContain("D1_ERROR: no such column: priority");
		expect(meta.event).toBe("error");
	});

	test("includes request info", () => {
		const event = makeEvent({
			request: { method: "GET", url: "https://example.runjack.xyz/api/tasks" },
			exceptions: [{ ts: Date.now(), name: "Error", message: "fail" }],
		});
		const { content } = formatChannelContent(event);
		expect(content).toContain("Request: GET https://example.runjack.xyz/api/tasks");
	});

	test("sets event type to exception when exceptions present", () => {
		const event = makeEvent({
			exceptions: [{ ts: Date.now(), name: "Error", message: "fail" }],
			logs: [{ ts: Date.now(), level: "error", message: ["also an error"] }],
		});
		const { meta } = formatChannelContent(event);
		expect(meta.event).toBe("exception");
	});

	test("sets event type to error when only error logs present", () => {
		const event = makeEvent({
			logs: [{ ts: Date.now(), level: "error", message: ["some error"] }],
		});
		const { meta } = formatChannelContent(event);
		expect(meta.event).toBe("error");
	});

	test("handles null exception fields gracefully", () => {
		const event = makeEvent({
			exceptions: [{ ts: null, name: null, message: null }],
		});
		const { content } = formatChannelContent(event);
		expect(content).toContain("Error: Unknown error");
	});

	test("includes outcome in meta", () => {
		const event = makeEvent({
			outcome: "exceededCpu",
			exceptions: [{ ts: Date.now(), name: "Error", message: "CPU limit" }],
		});
		const { meta } = formatChannelContent(event);
		expect(meta.outcome).toBe("exceededCpu");
	});

	test("describes resource-limit outcome when no exceptions or error logs", () => {
		const event = makeEvent({
			outcome: "exceededCpu",
			request: { method: "POST", url: "/api/heavy" },
		});
		const { content } = formatChannelContent(event);
		expect(content).toContain("Worker exceededCpu");
		expect(content).toContain("Request: POST /api/heavy");
	});
});
