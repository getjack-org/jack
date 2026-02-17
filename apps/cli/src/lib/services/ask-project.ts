import { authFetch } from "../auth/index.ts";
import { getControlApiUrl } from "../control-plane.ts";
import { readProjectLink } from "../project-link.ts";

export interface AskProjectHints {
	endpoint?: string;
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	deployment_id?: string;
}

export interface AskProjectOptions {
	projectDir: string;
	question: string;
	hints?: AskProjectHints;
}

export interface AskProjectEvidence {
	id: string;
	type: string;
	source: string;
	summary: string;
	timestamp: string;
	relation: "supports" | "conflicts" | "gap";
	meta?: Record<string, unknown>;
}

export interface AskProjectResult {
	answer: string;
	evidence: AskProjectEvidence[];
}

export async function askProject(options: AskProjectOptions): Promise<AskProjectResult> {
	const { projectDir, question, hints } = options;
	const trimmedQuestion = question.trim();
	if (!trimmedQuestion) {
		throw new Error("question is required");
	}

	const link = await readProjectLink(projectDir);
	if (!link) {
		throw new Error("Project is not linked. Run jack link or deploy a managed project first.");
	}

	if (link.deploy_mode !== "managed") {
		throw new Error("ask_project is only available for managed (Jack Cloud) projects.");
	}

	const response = await authFetch(`${getControlApiUrl()}/v1/projects/${link.project_id}/ask`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Jack-Source": "mcp_local",
		},
		body: JSON.stringify({
			question: trimmedQuestion,
			hints,
		}),
	});

	if (!response.ok) {
		const errBody = (await response.json().catch(() => ({}))) as {
			error?: string;
			message?: string;
		};
		throw new Error(errBody.message || `ask_project failed: ${response.status}`);
	}

	return response.json() as Promise<AskProjectResult>;
}
