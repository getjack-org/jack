import { describe, expect, it } from "bun:test";
import { generateVerificationWrapper } from "./verification-wrapper.ts";

describe("generateVerificationWrapper", () => {
	it("wraps fetch and re-exports the original module", () => {
		const source = generateVerificationWrapper("worker.js");

		expect(source).toContain('import * as __OrigWorkerModule from "./worker.js"');
		expect(source).toContain('prop !== "fetch"');
		expect(source).toContain("X-Jack-Verify-Route");
		expect(source).toContain("X-Jack-Worker-Reached");
		expect(source).toContain('export * from "./worker.js"');
	});
});
