import {
	ROUTING_VERIFICATION_REQUEST_HEADER,
	ROUTING_VERIFICATION_RESPONSE_HEADER,
} from "./assets-routing-verification";

function stringifyHeaderValue(name: string, value: string): string {
	return JSON.stringify({ [name]: value });
}

export function generateVerificationWrapper(originalModule: string): string {
	const requestHeaderJson = stringifyHeaderValue(ROUTING_VERIFICATION_REQUEST_HEADER, "1");
	const responseHeaderJson = stringifyHeaderValue(ROUTING_VERIFICATION_RESPONSE_HEADER, "1");

	return `import * as __OrigWorkerModule from "./${originalModule}";

const __OrigWorker = "default" in __OrigWorkerModule ? __OrigWorkerModule.default : __OrigWorkerModule;
const VERIFY_REQUEST = ${requestHeaderJson};
const VERIFY_RESPONSE = ${responseHeaderJson};

function __shouldMark(request) {
	return request instanceof Request && request.headers.get(Object.keys(VERIFY_REQUEST)[0]) === VERIFY_REQUEST[Object.keys(VERIFY_REQUEST)[0]];
}

function __markResponse(request, response) {
	if (!__shouldMark(request) || !(response instanceof Response)) {
		return response;
	}

	const marked = new Response(response.body, response);
	marked.headers.set(Object.keys(VERIFY_RESPONSE)[0], VERIFY_RESPONSE[Object.keys(VERIFY_RESPONSE)[0]]);
	return marked;
}

function __wrapWorker(worker) {
	if (!worker || typeof worker !== "object") {
		return worker;
	}

	return new Proxy(worker, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (prop !== "fetch" || typeof value !== "function") {
				return value;
			}

			return async function(request, env, ctx, ...rest) {
				const response = await value.call(target, request, env, ctx, ...rest);
				return __markResponse(request, response);
			};
		},
	});
}

export default __wrapWorker(__OrigWorker);
export * from "./${originalModule}";
`;
}
