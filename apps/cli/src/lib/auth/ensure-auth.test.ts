/**
 * Unit tests for ensure-auth.ts
 *
 * Tests the auth gate decision tree for project creation.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

// Mock modules before importing the module under test
const mockIsLoggedIn = mock(() => Promise.resolve(false));
const mockHasWrangler = mock(() => Promise.resolve(false));
const mockIsAuthenticated = mock(() => Promise.resolve(false));
const mockRunLoginFlow = mock(() => Promise.resolve({ success: true }));
const mockPromptSelect = mock(() => Promise.resolve(0));
const mockTrack = mock(() => {});

mock.module("./store.ts", () => ({
	isLoggedIn: mockIsLoggedIn,
}));

mock.module("../wrangler.ts", () => ({
	hasWrangler: mockHasWrangler,
	isAuthenticated: mockIsAuthenticated,
}));

mock.module("./login-flow.ts", () => ({
	runLoginFlow: mockRunLoginFlow,
}));

mock.module("../hooks.ts", () => ({
	promptSelect: mockPromptSelect,
}));

mock.module("../telemetry.ts", () => ({
	Events: { AUTH_GATE_RESOLVED: "auth_gate_resolved" },
	track: mockTrack,
}));

// Import after mocking
import { ensureAuthForCreate } from "./ensure-auth.ts";

// ============================================================================
// Tests
// ============================================================================

describe("ensureAuthForCreate", () => {
	beforeEach(() => {
		// Reset all mocks to default state
		mockIsLoggedIn.mockReset();
		mockHasWrangler.mockReset();
		mockIsAuthenticated.mockReset();
		mockRunLoginFlow.mockReset();
		mockPromptSelect.mockReset();
		mockTrack.mockReset();

		// Set default return values
		mockIsLoggedIn.mockResolvedValue(false);
		mockHasWrangler.mockResolvedValue(false);
		mockIsAuthenticated.mockResolvedValue(false);
		mockRunLoginFlow.mockResolvedValue({ success: true });
		mockPromptSelect.mockResolvedValue(0);

		// Suppress console.error during tests
		spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		mock.restore();
	});

	// ==========================================================================
	// PRD Test Scenarios
	// ==========================================================================

	describe("PRD Decision Tree", () => {
		it("proceeds immediately if already logged into jack cloud", async () => {
			// Scenario: Existing jack cloud user
			mockIsLoggedIn.mockResolvedValue(true);

			const result = await ensureAuthForCreate();

			expect(result.mode).toBe("managed");
			expect(result.didLogin).toBe(false);
			expect(mockRunLoginFlow).not.toHaveBeenCalled();
			expect(mockPromptSelect).not.toHaveBeenCalled();
			expect(mockTrack).toHaveBeenCalledWith("auth_gate_resolved", {
				mode: "managed",
				reason: "already_logged_in",
			});
		});

		it("proceeds with managed mode if logged in, even with wrangler available", async () => {
			// Scenario: Existing jack cloud user + wrangler
			mockIsLoggedIn.mockResolvedValue(true);
			mockHasWrangler.mockResolvedValue(true);
			mockIsAuthenticated.mockResolvedValue(true);

			const result = await ensureAuthForCreate();

			expect(result.mode).toBe("managed");
			expect(result.didLogin).toBe(false);
			expect(mockPromptSelect).not.toHaveBeenCalled();
		});

		it("prompts for choice when wrangler + CF auth available", async () => {
			// Scenario: Fresh user, wrangler + CF auth
			mockIsLoggedIn.mockResolvedValue(false);
			mockHasWrangler.mockResolvedValue(true);
			mockIsAuthenticated.mockResolvedValue(true);
			mockPromptSelect.mockResolvedValue(0); // User chooses jack cloud

			const result = await ensureAuthForCreate({ interactive: true });

			expect(mockPromptSelect).toHaveBeenCalled();
			expect(result.mode).toBe("managed");
			expect(result.didLogin).toBe(true);
			expect(mockRunLoginFlow).toHaveBeenCalled();
		});

		it("returns BYO mode when user chooses their Cloudflare account", async () => {
			// Scenario: Fresh user with wrangler + CF auth, chooses BYO
			mockIsLoggedIn.mockResolvedValue(false);
			mockHasWrangler.mockResolvedValue(true);
			mockIsAuthenticated.mockResolvedValue(true);
			mockPromptSelect.mockResolvedValue(1); // User chooses BYO

			const result = await ensureAuthForCreate({ interactive: true });

			expect(result.mode).toBe("byo");
			expect(result.didLogin).toBe(false);
			expect(mockRunLoginFlow).not.toHaveBeenCalled();
			expect(mockTrack).toHaveBeenCalledWith("auth_gate_resolved", {
				mode: "byo",
				reason: "user_chose_byo",
			});
		});

		it("auto-starts jack cloud login when no wrangler installed", async () => {
			// Scenario: Fresh user, no wrangler
			mockIsLoggedIn.mockResolvedValue(false);
			mockHasWrangler.mockResolvedValue(false);

			const result = await ensureAuthForCreate({ interactive: true });

			expect(result.mode).toBe("managed");
			expect(result.didLogin).toBe(true);
			expect(mockRunLoginFlow).toHaveBeenCalled();
			expect(mockPromptSelect).not.toHaveBeenCalled();
			expect(mockTrack).toHaveBeenCalledWith("auth_gate_resolved", {
				mode: "managed",
				reason: "auto_login_no_wrangler",
			});
		});

		it("auto-starts jack cloud login when wrangler installed but not authenticated", async () => {
			// Scenario: Fresh user, wrangler installed but not logged in
			mockIsLoggedIn.mockResolvedValue(false);
			mockHasWrangler.mockResolvedValue(true);
			mockIsAuthenticated.mockResolvedValue(false);

			const result = await ensureAuthForCreate({ interactive: true });

			expect(result.mode).toBe("managed");
			expect(result.didLogin).toBe(true);
			expect(mockRunLoginFlow).toHaveBeenCalled();
			expect(mockPromptSelect).not.toHaveBeenCalled();
			expect(mockTrack).toHaveBeenCalledWith("auth_gate_resolved", {
				mode: "managed",
				reason: "auto_login_no_cf_auth",
			});
		});
	});

	// ==========================================================================
	// Force Flags
	// ==========================================================================

	describe("Force flags", () => {
		it("respects forceByo flag without checking auth", async () => {
			mockIsLoggedIn.mockResolvedValue(true); // Even if logged in

			const result = await ensureAuthForCreate({ forceByo: true });

			expect(result.mode).toBe("byo");
			expect(result.didLogin).toBe(false);
			expect(mockTrack).toHaveBeenCalledWith("auth_gate_resolved", {
				mode: "byo",
				reason: "forced_byo",
			});
		});

		it("respects forceManaged flag and triggers login if needed", async () => {
			mockIsLoggedIn.mockResolvedValue(false);

			const result = await ensureAuthForCreate({ forceManaged: true });

			expect(result.mode).toBe("managed");
			expect(result.didLogin).toBe(true);
			expect(mockRunLoginFlow).toHaveBeenCalled();
		});

		it("respects forceManaged flag without login if already logged in", async () => {
			mockIsLoggedIn.mockResolvedValue(true);

			const result = await ensureAuthForCreate({ forceManaged: true });

			expect(result.mode).toBe("managed");
			expect(result.didLogin).toBe(false);
			expect(mockRunLoginFlow).not.toHaveBeenCalled();
		});

		it("throws error when both forceManaged and forceByo are set", async () => {
			await expect(
				ensureAuthForCreate({ forceManaged: true, forceByo: true }),
			).rejects.toThrow("Cannot use both --managed and --byo flags");
		});
	});

	// ==========================================================================
	// Non-interactive mode
	// ==========================================================================

	describe("Non-interactive mode", () => {
		it("uses BYO mode when wrangler + CF auth available in non-interactive mode", async () => {
			mockIsLoggedIn.mockResolvedValue(false);
			mockHasWrangler.mockResolvedValue(true);
			mockIsAuthenticated.mockResolvedValue(true);

			const result = await ensureAuthForCreate({ interactive: false });

			expect(result.mode).toBe("byo");
			expect(result.didLogin).toBe(false);
			expect(mockPromptSelect).not.toHaveBeenCalled();
			expect(mockTrack).toHaveBeenCalledWith("auth_gate_resolved", {
				mode: "byo",
				reason: "non_interactive_fallback",
			});
		});

		it("throws error in non-interactive mode when no auth available", async () => {
			mockIsLoggedIn.mockResolvedValue(false);
			mockHasWrangler.mockResolvedValue(false);

			await expect(ensureAuthForCreate({ interactive: false })).rejects.toThrow(
				"Not logged in and wrangler not authenticated",
			);
		});

		it("proceeds with managed mode in non-interactive if already logged in", async () => {
			mockIsLoggedIn.mockResolvedValue(true);

			const result = await ensureAuthForCreate({ interactive: false });

			expect(result.mode).toBe("managed");
			expect(result.didLogin).toBe(false);
		});
	});

	// ==========================================================================
	// Edge cases
	// ==========================================================================

	describe("Edge cases", () => {
		it("handles Esc key during prompt (defaults to jack cloud login)", async () => {
			mockIsLoggedIn.mockResolvedValue(false);
			mockHasWrangler.mockResolvedValue(true);
			mockIsAuthenticated.mockResolvedValue(true);
			mockPromptSelect.mockResolvedValue(-1); // Esc key

			const result = await ensureAuthForCreate({ interactive: true });

			expect(result.mode).toBe("managed");
			expect(result.didLogin).toBe(true);
			expect(mockRunLoginFlow).toHaveBeenCalled();
		});

		it("throws error when login flow fails", async () => {
			mockIsLoggedIn.mockResolvedValue(false);
			mockHasWrangler.mockResolvedValue(false);
			mockRunLoginFlow.mockResolvedValue({ success: false });

			await expect(ensureAuthForCreate({ interactive: true })).rejects.toThrow("Login failed");
		});
	});
});
