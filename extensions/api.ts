import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startModelBridge } from "./model-bridge.js";

const EXT_DIR = (() => {
	try {
		return path.dirname(fileURLToPath(import.meta.url));
	} catch {
		// eslint-disable-next-line no-undef
		return typeof __dirname !== "undefined" ? __dirname : process.cwd();
	}
})();
const PKG_ROOT = path.resolve(EXT_DIR, "..");
const EXE_SUFFIX = process.platform === "win32" ? ".exe" : "";
const MODEL_BRIDGE_PROTOCOL = "pi-meat-model-bridge-v1";

export interface MeatAbridgeRequest {
	cwd: string;
	target?: string;
	staged?: boolean;
	worktree?: boolean;
	diff?: string;
	noCache?: boolean;
}

export interface MeatAbridgeOptions {
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

export interface MeatAbridgeResult {
	summary: string;
	elision: string;
	smartDiff: string;
	inputTokens: number;
	outputTokens: number;
	cached: boolean;
	stderr: string;
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

function packageVersion(): string {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
		return typeof pkg.version === "string" ? pkg.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

function run(
	cmd: string,
	args: string[],
	opts: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		timeoutMs?: number;
		signal?: AbortSignal;
		input?: string;
	} = {},
): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		let kill: (() => void) | undefined;
		const cleanup = () => {
			if (kill && opts.signal) opts.signal.removeEventListener("abort", kill);
		};
		const child = execFile(
			cmd,
			args,
			{
				cwd: opts.cwd,
				env: opts.env ?? process.env,
				timeout: opts.timeoutMs,
				maxBuffer: 32 * 1024 * 1024,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				cleanup();
				if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
					reject(new Error(`command not found: ${cmd}`));
					return;
				}
				if (opts.signal?.aborted) {
					reject(new Error("cancelled"));
					return;
				}
				const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
				resolve({ code, stdout: String(stdout), stderr: String(stderr) });
			},
		);
		if (opts.signal) {
			kill = () => child.kill("SIGTERM");
			if (opts.signal.aborted) kill();
			else opts.signal.addEventListener("abort", kill, { once: true });
		}
		if (opts.input !== undefined && child.stdin) {
			child.stdin.write(opts.input);
			child.stdin.end();
		}
	});
}

function findOnPath(name: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, name + EXE_SUFFIX);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// keep looking
		}
	}
	return null;
}

let resolvedBinary: string | null = null;

async function supportsModelBridge(binary: string): Promise<boolean> {
	try {
		const result = await run(binary, ["-pi-bridge-info"], { timeoutMs: 5_000 });
		return result.code === 0 && result.stdout.trim() === MODEL_BRIDGE_PROTOCOL;
	} catch {
		return false;
	}
}

async function resolveBundledMeatBinary(onProgress?: (message: string) => void): Promise<string> {
	if (!findOnPath("go")) {
		throw new Error(
			"no bridge-compatible meat binary found and Go is not installed, so pi-meat cannot " +
				"build one from the bundled source. Install Go (https://go.dev) or update MEAT_BIN.",
		);
	}

	const cacheDir = path.join(
		process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
		"pi-meat",
	);
	fs.mkdirSync(cacheDir, { recursive: true });
	const target = path.join(
		cacheDir,
		`meat-${packageVersion()}-bridge-v1-${process.platform}-${process.arch}${EXE_SUFFIX}`,
	);
	if (!fs.existsSync(target)) {
		onProgress?.("building bridge-compatible meat from bundled Go source (one-time)…");
		const tmp = `${target}.tmp-${process.pid}`;
		const build = await run("go", ["build", "-o", tmp, "./cmd/meat"], {
			cwd: PKG_ROOT,
			timeoutMs: 180_000,
		});
		if (build.code !== 0) {
			try {
				fs.rmSync(tmp, { force: true });
			} catch {
				// ignore
			}
			throw new Error(`building meat from bundled source failed:\n${build.stderr.trim()}`);
		}
		fs.renameSync(tmp, target);
	}
	return target;
}

async function resolveMeatBinary(onProgress?: (message: string) => void): Promise<string> {
	if (resolvedBinary) return resolvedBinary;

	const explicit = process.env.MEAT_BIN;
	if (explicit) {
		if (!fs.existsSync(explicit)) {
			throw new Error(`MEAT_BIN is set to ${explicit} but that file does not exist`);
		}
		if (!(await supportsModelBridge(explicit))) {
			throw new Error(
				`MEAT_BIN is set to ${explicit}, but that binary is not compatible with pi's active-model bridge`,
			);
		}
		resolvedBinary = explicit;
		return resolvedBinary;
	}

	const onPath = findOnPath("meat");
	if (onPath && (await supportsModelBridge(onPath))) {
		resolvedBinary = onPath;
		return resolvedBinary;
	}

	resolvedBinary = await resolveBundledMeatBinary(onProgress);
	return resolvedBinary;
}

export function meatInvocationLabel(request: MeatAbridgeRequest): string {
	if (request.diff !== undefined) return "stdin diff";
	if (request.staged) return "staged changes";
	if (request.worktree) return "working-tree changes";
	return request.target ?? "HEAD";
}

export async function abridgeWithActiveModel(
	ctx: ExtensionContext,
	request: MeatAbridgeRequest,
	options: MeatAbridgeOptions = {},
): Promise<MeatAbridgeResult> {
	const modes = [
		request.target !== undefined,
		request.staged,
		request.worktree,
		request.diff !== undefined,
	].filter(Boolean).length;
	if (modes > 1) {
		throw new Error("target, staged, worktree, and diff are mutually exclusive — pick one");
	}

	const binary = await resolveMeatBinary(options.onProgress);
	const bridge = await startModelBridge(ctx, options.signal);
	const args = ["-json", "-model", bridge.cacheIdentity];
	if (request.noCache) args.push("-no-cache");
	if (request.staged) args.push("-staged");
	if (request.worktree) args.push("-w");
	// A spawned meat has piped stdin, so pass an explicit revision unless the
	// caller supplied a diff on stdin.
	if (request.diff === undefined && !request.staged && !request.worktree) {
		args.push(request.target ?? "HEAD");
	}

	let result: RunResult;
	try {
		result = await run(binary, args, {
			cwd: request.cwd,
			env: {
				...process.env,
				PI_MEAT_MODEL_BRIDGE_URL: bridge.url,
				PI_MEAT_MODEL_BRIDGE_TOKEN: bridge.token,
			},
			signal: options.signal,
			timeoutMs: 10 * 60 * 1000,
			input: request.diff,
		});
	} finally {
		await bridge.close();
	}
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new Error(`meat ${meatInvocationLabel(request)} failed: ${detail}`);
	}

	let parsed: {
		smart_diff?: string;
		summary?: string;
		input_tokens?: number;
		output_tokens?: number;
		elision?: string;
	};
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error(`meat produced unparseable output: ${result.stdout.slice(0, 500)}`);
	}

	return {
		summary: parsed.summary ?? "",
		elision: parsed.elision ?? "",
		smartDiff: parsed.smart_diff ?? "",
		inputTokens: parsed.input_tokens ?? 0,
		outputTokens: parsed.output_tokens ?? 0,
		cached: /meat: cached/.test(result.stderr),
		stderr: result.stderr.trim(),
	};
}
