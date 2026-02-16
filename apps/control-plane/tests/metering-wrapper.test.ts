import { describe, it, expect } from "bun:test";
import { generateMeteringWrapper } from "../src/metering-wrapper.ts";

describe("generateMeteringWrapper", () => {
	it("generates DO-only wrapper", () => {
		const result = generateMeteringWrapper({
			originalModule: "index.js",
			projectId: "proj_123",
			orgId: "org_456",
			doClassNames: ["MyDO", "Counter"],
		});

		// Should contain DO imports
		expect(result).toContain(
			'import { MyDO as __Orig_MyDO, Counter as __Orig_Counter } from "./index.js"',
		);
		// Should contain wrapDO function
		expect(result).toContain("function wrapDO(");
		// Should wrap both classes
		expect(result).toContain('const MyDO = wrapDO(__Orig_MyDO, "MyDO")');
		expect(result).toContain(
			'const Counter = wrapDO(__Orig_Counter, "Counter")',
		);
		// Should export wrapped classes
		expect(result).toContain("export { MyDO, Counter }");
		// Should use __JACK_USAGE for DO metering
		expect(result).toContain("__JACK_USAGE");
		// Should re-export default unchanged (no vectorize wrapping)
		expect(result).toContain('export { default } from "./index.js"');
		// Should NOT contain vectorize code
		expect(result).not.toContain("wrapVectorize");
		expect(result).not.toContain("__JACK_VECTORIZE_USAGE");
	});

	it("generates vectorize-only wrapper", () => {
		const result = generateMeteringWrapper({
			originalModule: "index.js",
			projectId: "proj_abc",
			orgId: "org_def",
			vectorizeBindings: [
				{ bindingName: "VECTORS", indexName: "jack-abc-vectors" },
			],
		});

		// Should import default worker
		expect(result).toContain('import __OrigWorker from "./index.js"');
		// Should contain wrapVectorize function
		expect(result).toContain("function wrapVectorize(");
		// Should contain Proxy usage
		expect(result).toContain("new Proxy(");
		// Should contain Reflect.get
		expect(result).toContain("Reflect.get(");
		// Should wrap default export via Proxy for all lifecycle methods
		expect(result).toContain("new Proxy(__OrigWorker");
		expect(result).toContain("handler.call(target");
		// Should have __wrapEnv that checks VECTORS binding
		expect(result).toContain("function __wrapEnv(env)");
		expect(result).toContain("env.VECTORS && env.__JACK_VECTORIZE_USAGE");
		// Should pass index name
		expect(result).toContain('"jack-abc-vectors"');
		// Should use __JACK_VECTORIZE_USAGE
		expect(result).toContain("__JACK_VECTORIZE_USAGE");
		// Should NOT contain DO code
		expect(result).not.toContain("wrapDO");
		expect(result).not.toContain("__JACK_USAGE");
	});

	it("generates combined DO + vectorize wrapper", () => {
		const result = generateMeteringWrapper({
			originalModule: "worker.mjs",
			projectId: "proj_both",
			orgId: "org_both",
			doClassNames: ["Counter"],
			vectorizeBindings: [
				{ bindingName: "VECTORS", indexName: "jack-both-vectors" },
			],
		});

		// Should have both DO and vectorize code
		expect(result).toContain("wrapDO");
		expect(result).toContain("wrapVectorize");
		// Should import DO classes AND default worker
		expect(result).toContain(
			'import { Counter as __Orig_Counter } from "./worker.mjs"',
		);
		expect(result).toContain('import __OrigWorker from "./worker.mjs"');
		// Should wrap default export via Proxy (NOT re-export)
		expect(result).toContain("new Proxy(__OrigWorker");
		expect(result).not.toContain('export { default } from');
		// Both AE bindings referenced
		expect(result).toContain("__JACK_USAGE");
		expect(result).toContain("__JACK_VECTORIZE_USAGE");
	});

	it("generates wrapper for multiple vectorize bindings", () => {
		const result = generateMeteringWrapper({
			originalModule: "index.js",
			projectId: "proj_multi",
			orgId: "org_multi",
			vectorizeBindings: [
				{ bindingName: "VECTORS", indexName: "jack-multi-vectors" },
				{ bindingName: "EMBEDDINGS", indexName: "jack-multi-embeddings" },
			],
		});

		// Should wrap both bindings
		expect(result).toContain("env.VECTORS");
		expect(result).toContain("env.EMBEDDINGS");
		expect(result).toContain('"jack-multi-vectors"');
		expect(result).toContain('"jack-multi-embeddings"');
	});

	it("throws on invalid class names", () => {
		expect(() =>
			generateMeteringWrapper({
				originalModule: "index.js",
				projectId: "p",
				orgId: "o",
				doClassNames: ["123Invalid"],
			}),
		).toThrow("Invalid class name");
	});

	it("throws on empty originalModule", () => {
		expect(() =>
			generateMeteringWrapper({
				originalModule: "",
				projectId: "p",
				orgId: "o",
				doClassNames: ["Foo"],
			}),
		).toThrow();
	});

	it("throws when no DO or vectorize bindings provided", () => {
		expect(() =>
			generateMeteringWrapper({
				originalModule: "index.js",
				projectId: "p",
				orgId: "o",
			}),
		).toThrow();
	});

	it("wraps all lifecycle methods via Proxy (not just fetch)", () => {
		const result = generateMeteringWrapper({
			originalModule: "index.js",
			projectId: "proj_lc",
			orgId: "org_lc",
			vectorizeBindings: [
				{ bindingName: "VECTORS", indexName: "jack-lc-vectors" },
			],
		});

		// Proxy intercepts any handler method, wrapping env (2nd arg)
		// This covers fetch, scheduled, queue, email, tail, etc.
		expect(result).toContain("new Proxy(__OrigWorker");
		expect(result).toContain("get(target, prop)");
		expect(result).toContain("handler.call(target, arg1, __wrapEnv(env), ...rest)");
		// Should NOT hardcode individual handler names (Proxy handles them all)
		expect(result).not.toContain("__OrigWorker.fetch(");
		expect(result).not.toContain("__OrigWorker.scheduled(");
	});

	it("hardcodes projectId and orgId as string constants", () => {
		const result = generateMeteringWrapper({
			originalModule: "index.js",
			projectId: "proj_sec",
			orgId: "org_sec",
			vectorizeBindings: [{ bindingName: "VECTORS", indexName: "idx" }],
		});

		expect(result).toContain('const PROJECT_ID = "proj_sec"');
		expect(result).toContain('const ORG_ID = "org_sec"');
	});
});
