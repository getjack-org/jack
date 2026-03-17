import { describe, expect, test } from "bun:test";
import { __internalPostDeployParsing } from "../src/commands/internal.ts";

describe("internal post-deploy parsing", () => {
	test("matches deploy tool names from plain and MCP-prefixed formats", () => {
		expect(__internalPostDeployParsing.isDeployProjectToolName("deploy_project")).toBe(true);
		expect(__internalPostDeployParsing.isDeployProjectToolName("mcp__jack__deploy_project")).toBe(
			true,
		);
		expect(__internalPostDeployParsing.isDeployProjectToolName("mcp__other__deploy_project")).toBe(
			true,
		);
		expect(__internalPostDeployParsing.isDeployProjectToolName("get_project_status")).toBe(false);
		expect(__internalPostDeployParsing.isDeployProjectToolName(null)).toBe(false);
	});

	test("extracts deployment id from common hook tool_response shapes", () => {
		const jsonString =
			'{"success":true,"data":{"deploymentId":"dep_11111111-2222-3333-4444-555555555555"}}';
		expect(__internalPostDeployParsing.extractDeploymentIdFromUnknown(jsonString)).toBe(
			"dep_11111111-2222-3333-4444-555555555555",
		);

		const claudeToolBlocks = [
			{
				type: "text",
				text: '{"success":true,"data":{"deploymentId":"dep_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}}',
			},
		];
		expect(__internalPostDeployParsing.extractDeploymentIdFromUnknown(claudeToolBlocks)).toBe(
			"dep_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		);

		const nestedObject = {
			response: {
				payload: {
					result: {
						data: {
							deploymentId: "dep_99999999-8888-7777-6666-555555555555",
						},
					},
				},
			},
		};
		expect(__internalPostDeployParsing.extractDeploymentIdFromUnknown(nestedObject)).toBe(
			"dep_99999999-8888-7777-6666-555555555555",
		);

		expect(
			__internalPostDeployParsing.extractDeploymentIdFromUnknown(
				"deployment completed: dep_feedface-1234-5678-90ab-cafebabefeed",
			),
		).toBe("dep_feedface-1234-5678-90ab-cafebabefeed");
	});

	test("extracts project path from direct and nested tool input", () => {
		expect(
			__internalPostDeployParsing.extractProjectPathFromUnknown({
				project_path: "/Users/hellno/.jack/projects/bumpy-emus-mate",
			}),
		).toBe("/Users/hellno/.jack/projects/bumpy-emus-mate");

		const nested = {
			arguments:
				'{"payload":{"input":{"projectPath":"/Users/hellno/.jack/projects/cozy-paws-relate"}}}',
		};
		expect(__internalPostDeployParsing.extractProjectPathFromUnknown(nested)).toBe(
			"/Users/hellno/.jack/projects/cozy-paws-relate",
		);
	});
});
