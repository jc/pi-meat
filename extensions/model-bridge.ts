import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	Provider,
	TextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as crypto from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const PI_PROVIDER_STATE = "pi";

interface BridgeBlock {
	type: "text" | "tool_use" | "tool_result" | "provider_state";
	text?: string;
	id?: string;
	tool_name?: string;
	tool_input?: unknown;
	tool_use_id?: string;
	tool_result?: string;
	tool_error?: boolean;
	provider?: string;
	provider_data?: unknown;
}

interface BridgeMessage {
	role: "user" | "assistant";
	content: BridgeBlock[];
}

interface BridgeTool {
	name: string;
	description: string;
	input_schema: unknown;
}

interface BridgeRequest {
	system: string;
	messages: BridgeMessage[];
	tools: BridgeTool[];
}

interface BridgeResponse {
	content: BridgeBlock[];
	input_tokens: number;
	output_tokens: number;
}

export interface ModelBridge {
	url: string;
	token: string;
	cacheIdentity: string;
	close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, stableValue(value[key])]),
	);
}

function modelConfigDigest(
	model: Model<any>,
	thinkingLevel: ExtensionContext["thinkingLevel"],
	providerConfig: unknown,
): string {
	// Model/provider configuration can include sensitive header or environment values.
	// Hash the complete behavior-bearing shape, but expose only a short one-way digest
	// in argv/cache keys. API keys are intentionally excluded so token rotation does not
	// invalidate otherwise equivalent results.
	return crypto
		.createHash("sha256")
		.update(
			JSON.stringify(
				stableValue({ model, thinkingLevel: thinkingLevel ?? "off", providerConfig }),
			),
		)
		.digest("hex")
		.slice(0, 16);
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	return isRecord(value) && value.role === "assistant" && Array.isArray(value.content);
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function fallbackAssistantMessage(message: BridgeMessage, model: Model<any>): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "text" && block.text !== undefined) {
			content.push({ type: "text", text: block.text });
		} else if (block.type === "tool_use") {
			if (!block.id || !block.tool_name || !isRecord(block.tool_input)) {
				throw new Error("pi-meat bridge received an invalid assistant tool call");
			}
			content.push({
				type: "toolCall",
				id: block.id,
				name: block.tool_name,
				arguments: block.tool_input,
			});
		}
	}
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

export function toPiMessages(messages: BridgeMessage[], model: Model<any>): Message[] {
	const result: Message[] = [];
	const toolNames = new Map<string, string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			const state = message.content.find(
				(block) => block.type === "provider_state" && block.provider === PI_PROVIDER_STATE,
			);
			let assistant: AssistantMessage;
			if (state) {
				if (!isAssistantMessage(state.provider_data)) {
					throw new Error("pi-meat bridge received invalid pi provider state");
				}
				assistant = state.provider_data;
			} else {
				assistant = fallbackAssistantMessage(message, model);
			}
			result.push(assistant);
			for (const block of assistant.content) {
				if (block.type === "toolCall") toolNames.set(block.id, block.name);
			}
			continue;
		}

		let pendingText: TextContent[] = [];
		const flushText = () => {
			if (pendingText.length === 0) return;
			const userMessage: UserMessage = {
				role: "user",
				content: pendingText,
				timestamp: Date.now(),
			};
			result.push(userMessage);
			pendingText = [];
		};

		for (const block of message.content) {
			if (block.type === "text" && block.text !== undefined) {
				pendingText.push({ type: "text", text: block.text });
				continue;
			}
			if (block.type === "tool_result") {
				flushText();
				if (!block.tool_use_id) {
					throw new Error("pi-meat bridge received a tool result without a tool call id");
				}
				const toolResult: ToolResultMessage = {
					role: "toolResult",
					toolCallId: block.tool_use_id,
					toolName: toolNames.get(block.tool_use_id) ?? "",
					content: [{ type: "text", text: block.tool_result ?? "" }],
					isError: block.tool_error ?? false,
					timestamp: Date.now(),
				};
				result.push(toolResult);
			}
		}
		flushText();
	}
	return result;
}

function toPiTools(tools: BridgeTool[]): Tool[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.input_schema as Tool["parameters"],
	}));
}

export function fromPiResponse(response: AssistantMessage): BridgeResponse {
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage || `selected pi model stopped with ${response.stopReason}`);
	}
	if (response.stopReason === "length") {
		throw new Error("selected pi model reached its output limit before submitting an abridgement");
	}

	const content: BridgeBlock[] = [];
	for (const block of response.content) {
		if (block.type === "text") {
			content.push({ type: "text", text: block.text });
		} else if (block.type === "toolCall") {
			const toolCall = block as ToolCall;
			content.push({
				type: "tool_use",
				id: toolCall.id,
				tool_name: toolCall.name,
				tool_input: toolCall.arguments,
			});
		}
	}
	// Replay the complete normalized message on the next turn. This preserves
	// encrypted reasoning, signatures, and provider-specific tool-call metadata.
	content.push({ type: "provider_state", provider: PI_PROVIDER_STATE, provider_data: response });

	return {
		content,
		input_tokens: response.usage.input + response.usage.cacheRead + response.usage.cacheWrite,
		output_tokens: response.usage.output,
	};
}

async function readBridgeRequest(req: IncomingMessage): Promise<BridgeRequest> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_REQUEST_BYTES) throw new Error("pi-meat bridge request is too large");
		chunks.push(buffer);
	}
	const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	if (!isRecord(parsed) || typeof parsed.system !== "string" || !Array.isArray(parsed.messages) || !Array.isArray(parsed.tools)) {
		throw new Error("pi-meat bridge received an invalid request");
	}
	return parsed as unknown as BridgeRequest;
}

function sendJSON(res: ServerResponse, status: number, value: unknown): void {
	if (res.destroyed || res.writableEnded) return;
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(value));
}

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("pi-meat bridge did not receive a TCP address"));
				return;
			}
			resolve(address.port);
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
		server.closeAllConnections();
	});
}

export async function startModelBridge(
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<ModelBridge> {
	if (!ctx.model) throw new Error("pi-meat: no model is selected in the current pi session");

	const model = { ...ctx.model } as Model<any>;
	const thinkingLevel = ctx.thinkingLevel;
	const provider = ctx.modelRegistry.getProvider(model.provider) as Provider<any> | undefined;
	if (!provider) throw new Error(`pi-meat: provider ${model.provider} is unavailable`);

	// Resolve once per invocation so every turn uses the same selected-model auth and
	// the cache identity reflects effective routing without exposing credential values.
	const [requestAuth, providerAuth] = await Promise.all([
		ctx.modelRegistry.getApiKeyAndHeaders(model),
		ctx.modelRegistry.getProviderAuth(model.provider),
	]);
	if (!requestAuth.ok) throw new Error(requestAuth.error);
	const effectiveModel = providerAuth?.auth.baseUrl
		? ({ ...model, baseUrl: providerAuth.auth.baseUrl } as Model<any>)
		: model;

	const token = crypto.randomBytes(32).toString("hex");
	const sessionId = `${ctx.sessionManager.getSessionId()}:pi-meat:${crypto.randomUUID()}`;
	const configDigest = modelConfigDigest(effectiveModel, thinkingLevel, {
		headers: requestAuth.headers,
		env: requestAuth.env,
	});
	const cacheIdentity = `${model.provider}/${model.api}/${model.id}:${thinkingLevel ?? "off"}:${configDigest}`;

	const server = createServer(async (req, res) => {
		const requestAbort = new AbortController();
		const abortRequest = () => requestAbort.abort();
		if (signal?.aborted) abortRequest();
		else signal?.addEventListener("abort", abortRequest, { once: true });
		req.once("aborted", abortRequest);
		res.once("close", abortRequest);
		try {
			if (req.method !== "POST" || req.url !== "/generate") {
				sendJSON(res, 404, { error: "not found" });
				return;
			}
			if (req.headers.authorization !== `Bearer ${token}`) {
				sendJSON(res, 401, { error: "unauthorized" });
				return;
			}

			const request = await readBridgeRequest(req);
			const context: Context = {
				systemPrompt: request.system,
				messages: toPiMessages(request.messages, effectiveModel),
				tools: toPiTools(request.tools),
			};
			const stream = provider.streamSimple(effectiveModel, context, {
				apiKey: requestAuth.apiKey,
				headers: requestAuth.headers,
				env: requestAuth.env,
				reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
				signal: requestAbort.signal,
				cacheRetention: "none",
				sessionId,
			});
			const response = await stream.result();
			sendJSON(res, 200, fromPiResponse(response));
		} catch (error) {
			sendJSON(res, 500, { error: error instanceof Error ? error.message : String(error) });
		} finally {
			signal?.removeEventListener("abort", abortRequest);
			req.off("aborted", abortRequest);
			res.off("close", abortRequest);
		}
	});

	const port = await listen(server);
	let closed = false;
	return {
		url: `http://127.0.0.1:${port}/generate`,
		token,
		cacheIdentity,
		async close() {
			if (closed) return;
			closed = true;
			await closeServer(server);
		},
	};
}
