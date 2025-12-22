// Normalized service type constants
export const ServiceType = {
	DB: "db",
	KV: "kv",
	CRON: "cron",
	QUEUE: "queue",
	STORAGE: "storage",
} as const;

export type ServiceTypeKey = keyof typeof ServiceType;
export type ServiceTypeValue = (typeof ServiceType)[ServiceTypeKey];

// Template metadata interface for service requirements
export interface TemplateServiceRequirements {
	requires: ServiceTypeKey[];
}

// Helper to check if template requires a service
export function templateRequiresService(
	templateMetadata: TemplateServiceRequirements | undefined,
	serviceType: ServiceTypeKey,
): boolean {
	if (!templateMetadata) {
		return false;
	}
	return templateMetadata.requires.includes(serviceType);
}
