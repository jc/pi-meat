import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let buildDir;
let bridgeModule;

before(async () => {
	buildDir = await mkdtemp(path.join(tmpdir(), "pi-meat-bridge-test-"));
	await execFileAsync(
		process.execPath,
		[
			path.join(root, "node_modules", "typescript", "bin", "tsc"),
			"--project",
			path.join(root, "tsconfig.json"),
			"--noEmit",
			"false",
			"--outDir",
			buildDir,
		],
		{ cwd: root },
	);
	bridgeModule = await import(pathToFileURL(path.join(buildDir, "model-bridge.js")).href);
});

after(async () => {
	if (buildDir) await rm(buildDir, { recursive: true, force: true });
});

function model(overrides = {}) {
	return {
		id: "session-model",
		name: "Session model",
		api: "openai-codex-responses",
		provider: "mock-provider",
		baseUrl: "https://models.example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
		compat: { supportsStore: false },
		...overrides,
	};
}

function context(selectedModel, provider, auth = {}) {
	const { providerBaseUrl = "https://effective.example.test", ...requestAuth } = auth;
	return {
		model: selectedModel,
		thinkingLevel: "high",
		sessionManager: { getSessionId: () => "test-session" },
		modelRegistry: {
			getProvider: (id) => (id === selectedModel.provider ? provider : undefined),
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "session-oauth-token",
				headers: { "x-route": "selected" },
				env: { REGION: "session-region" },
				...requestAuth,
			}),
			getProviderAuth: async () => ({
				auth: { apiKey: "session-oauth-token", baseUrl: providerBaseUrl },
			}),
		},
	};
}

function assistant(selectedModel, content, stopReason = "toolUse") {
	return {
		role: "assistant",
		content,
		api: selectedModel.api,
		provider: selectedModel.provider,
		model: selectedModel.id,
		usage: {
			input: 3,
			output: 4,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

test("provider state round-trips and restores tool names", () => {
	const selectedModel = model();
	const response = assistant(selectedModel, [
		{ type: "toolCall", id: "call-1", name: "submit", arguments: { summary: "x" } },
	]);
	const wire = bridgeModule.fromPiResponse(response);
	assert.equal(wire.input_tokens, 6);
	assert.equal(wire.output_tokens, 4);

	const messages = bridgeModule.toPiMessages(
		[
			{ role: "assistant", content: wire.content },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "call-1", tool_result: "ok" }],
			},
		],
		selectedModel,
	);
	assert.deepEqual(messages[0], response);
	assert.equal(messages[1].toolCallId, "call-1");
	assert.equal(messages[1].toolName, "submit");
});

test("bridge uses the selected provider, auth, base URL, and thinking level", async () => {
	const selectedModel = model();
	let seen;
	const provider = {
		streamSimple(requestModel, requestContext, options) {
			seen = { requestModel, requestContext, options };
			return {
				result: async () => assistant(selectedModel, [{ type: "text", text: "done" }], "stop"),
			};
		},
	};
	const bridge = await bridgeModule.startModelBridge(context(selectedModel, provider));
	try {
		const unauthorized = await fetch(bridge.url, { method: "POST", body: "{}" });
		assert.equal(unauthorized.status, 401);

		const response = await fetch(bridge.url, {
			method: "POST",
			headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
			body: JSON.stringify({
				system: "system",
				messages: [{ role: "user", content: [{ type: "text", text: "diff" }] }],
				tools: [{ name: "submit", description: "submit", input_schema: { type: "object" } }],
			}),
		});
		assert.equal(response.status, 200);
		assert.equal(seen.requestModel.id, selectedModel.id);
		assert.equal(seen.requestModel.baseUrl, "https://effective.example.test");
		assert.equal(seen.options.apiKey, "session-oauth-token");
		assert.deepEqual(seen.options.headers, { "x-route": "selected" });
		assert.deepEqual(seen.options.env, { REGION: "session-region" });
		assert.equal(seen.options.reasoning, "high");
		assert.equal(seen.requestContext.tools[0].name, "submit");
	} finally {
		await bridge.close();
	}
});

test("cache identity changes with resolved provider configuration", async () => {
	const provider = { streamSimple: () => ({ result: async () => undefined }) };
	const first = await bridgeModule.startModelBridge(context(model(), provider));
	const second = await bridgeModule.startModelBridge(
		context(model(), provider, {
			providerBaseUrl: "https://other.example.test",
			headers: { "x-route": "other" },
		}),
	);
	try {
		assert.notEqual(first.cacheIdentity, second.cacheIdentity);
		assert.equal(first.cacheIdentity.includes("session-oauth-token"), false);
	} finally {
		await Promise.all([first.close(), second.close()]);
	}
});

test("client disconnect aborts the in-flight provider request", async () => {
	const selectedModel = model();
	let providerStarted;
	let providerAborted;
	const started = new Promise((resolve) => (providerStarted = resolve));
	const aborted = new Promise((resolve) => (providerAborted = resolve));
	const provider = {
		streamSimple(_requestModel, _requestContext, options) {
			providerStarted();
			return {
				result: () =>
					new Promise((resolve, reject) => {
						options.signal.addEventListener(
							"abort",
							() => {
								providerAborted();
								reject(new Error("aborted"));
							},
							{ once: true },
						);
					}),
			};
		},
	};
	const bridge = await bridgeModule.startModelBridge(context(selectedModel, provider));
	const controller = new AbortController();
	try {
		const request = fetch(bridge.url, {
			method: "POST",
			headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
			body: JSON.stringify({ system: "system", messages: [], tools: [] }),
			signal: controller.signal,
		});
		await started;
		controller.abort();
		await assert.rejects(request, { name: "AbortError" });
		await Promise.race([
			aborted,
			new Promise((_, reject) => setTimeout(() => reject(new Error("provider was not aborted")), 1000)),
		]);
	} finally {
		await bridge.close();
	}
});
