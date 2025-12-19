export enum JackErrorCode {
	AUTH_FAILED = "AUTH_FAILED",
	WRANGLER_AUTH_EXPIRED = "WRANGLER_AUTH_EXPIRED",
	PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND",
	TEMPLATE_NOT_FOUND = "TEMPLATE_NOT_FOUND",
	BUILD_FAILED = "BUILD_FAILED",
	DEPLOY_FAILED = "DEPLOY_FAILED",
	VALIDATION_ERROR = "VALIDATION_ERROR",
	INTERNAL_ERROR = "INTERNAL_ERROR",
}

export interface JackErrorMeta {
	exitCode?: number;
	missingSecrets?: string[];
	stderr?: string;
	reported?: boolean;
}

export class JackError extends Error {
	code: JackErrorCode;
	suggestion?: string;
	meta?: JackErrorMeta;

	constructor(code: JackErrorCode, message: string, suggestion?: string, meta?: JackErrorMeta) {
		super(message);
		this.name = "JackError";
		this.code = code;
		this.suggestion = suggestion;
		this.meta = meta;
	}
}

export function isJackError(error: unknown): error is JackError {
	return error instanceof JackError;
}

export function getErrorDetails(error: unknown): {
	message: string;
	suggestion?: string;
	meta?: JackErrorMeta;
	code?: JackErrorCode;
} {
	if (isJackError(error)) {
		return {
			message: error.message,
			suggestion: error.suggestion,
			meta: error.meta,
			code: error.code,
		};
	}

	return { message: error instanceof Error ? error.message : String(error) };
}
