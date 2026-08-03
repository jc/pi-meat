/**
 * pi-meat — pi extension wrapping the `meat` CLI.
 *
 * meat abridges a code diff into a "reading diff": an LLM drops everything a
 * senior reviewer does not need to read (batch field copies, error-message
 * construction, forced zero-value returns, generated code) and keeps the
 * behavior-bearing changes, plus a one-line summary.
 *
 * This extension provides:
 *   - a `meat` tool the agent can call (commit, range, staged, worktree, or
 *     an arbitrary unified diff), and
 *   - a `/meat [target]` command that abridges a change and injects the
 *     reading diff into the session as context.
 *
 * Binary resolution order:
 *   1. $MEAT_BIN (explicit path to a meat binary)
 *   2. `meat` on $PATH (e.g. `go install meat.dev/cmd/meat@latest`)
 *   3. `go build` of the Go source bundled in this package, cached under
 *      ${XDG_CACHE_HOME:-~/.cache}/pi-meat/ keyed by package version/platform.
 *
 * Model access: extension invocations use the model currently selected in the
 * active pi session. Provider calls stay in pi, so its resolved API key/OAuth,
 * headers, provider-scoped environment, base URL, and thinking level are reused.
 * Standalone meat CLI invocations keep their normal environment-based behavior.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { startModelBridge } from "./model-bridge.js";
import { Text } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// Paths & package metadata
// ---------------------------------------------------------------------------

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

function packageVersion(): string {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
		return typeof pkg.version === "string" ? pkg.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

// ---------------------------------------------------------------------------
// Process spawning
// ---------------------------------------------------------------------------

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
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

// ---------------------------------------------------------------------------
// meat binary resolution: compatible MEAT_BIN → PATH → bundled Go source
// ---------------------------------------------------------------------------

const MODEL_BRIDGE_PROTOCOL = "pi-meat-model-bridge-v1";
let resolvedBinary: string | null = null;

async function supportsModelBridge(binary: string): Promise<boolean> {
	try {
		const result = await run(binary, ["-pi-bridge-info"], { timeoutMs: 5_000 });
		return result.code === 0 && result.stdout.trim() === MODEL_BRIDGE_PROTOCOL;
	} catch {
		return false;
	}
}

async function resolveBundledMeatBinary(onUpdate?: (msg: string) => void): Promise<string> {
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
		onUpdate?.("building bridge-compatible meat from bundled Go source (one-time)…");
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
		fs.renameSync(tmp, target); // atomic publish; concurrent builders race harmlessly
	}
	return target;
}

async function resolveMeatBinary(onUpdate?: (msg: string) => void): Promise<string> {
	if (resolvedBinary) return resolvedBinary;

	const explicit = process.env.MEAT_BIN;
	if (explicit) {
		if (!fs.existsSync(explicit)) {
			throw new Error(`MEAT_BIN is set to ${explicit} but that file does not exist`);
		}
		if (!(await supportsModelBridge(explicit))) {
			throw new Error(`MEAT_BIN is set to ${explicit}, but that binary is not compatible with pi's active-model bridge`);
		}
		resolvedBinary = explicit;
		return resolvedBinary;
	}

	const onPath = findOnPath("meat");
	if (onPath && (await supportsModelBridge(onPath))) {
		resolvedBinary = onPath;
		return resolvedBinary;
	}

	resolvedBinary = await resolveBundledMeatBinary(onUpdate);
	return resolvedBinary;
}


// ---------------------------------------------------------------------------
// Running meat
// ---------------------------------------------------------------------------

interface MeatResult {
	summary: string;
	elision: string;
	smartDiff: string;
	inputTokens: number;
	outputTokens: number;
	cached: boolean;
	stderr: string;
}

interface MeatInvocation {
	target?: string;
	staged?: boolean;
	worktree?: boolean;
	diff?: string;
	noCache?: boolean;
	cwd: string;
}

function invocationLabel(inv: MeatInvocation): string {
	if (inv.diff !== undefined) return "stdin diff";
	if (inv.staged) return "staged changes";
	if (inv.worktree) return "working-tree changes";
	return inv.target ?? "HEAD";
}

async function runMeat(
	inv: MeatInvocation,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	onUpdate?: (msg: string) => void,
): Promise<MeatResult> {
	const modes = [inv.target !== undefined, inv.staged, inv.worktree, inv.diff !== undefined].filter(
		Boolean,
	).length;
	if (modes > 1) {
		throw new Error("target, staged, worktree, and diff are mutually exclusive — pick one");
	}

	const binary = await resolveMeatBinary(onUpdate);
	const bridge = await startModelBridge(ctx, signal);
	const args = ["-json", "-model", bridge.cacheIdentity];
	if (inv.noCache) args.push("-no-cache");
	if (inv.staged) args.push("-staged");
	if (inv.worktree) args.push("-w");
	// Always pass an explicit revision when not reading a diff from stdin:
	// a spawned meat has a piped (non-tty) stdin, so with no arguments it would
	// read stdin instead of defaulting to HEAD.
	if (inv.diff === undefined && !inv.staged && !inv.worktree) args.push(inv.target ?? "HEAD");

	let result: RunResult;
	try {
		result = await run(binary, args, {
			cwd: inv.cwd,
			env: {
				...process.env,
				PI_MEAT_MODEL_BRIDGE_URL: bridge.url,
				PI_MEAT_MODEL_BRIDGE_TOKEN: bridge.token,
			},
			signal,
			timeoutMs: 10 * 60 * 1000,
			input: inv.diff,
		});
	} finally {
		await bridge.close();
	}
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new Error(`meat ${invocationLabel(inv)} failed: ${detail}`);
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

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatMeatText(res: MeatResult, label: string): string {
	const parts = [`# meat: ${label}`, "", `**${res.summary}**`];
	if (res.elision) parts.push("", res.elision);
	if (res.smartDiff.trim()) parts.push("", "```diff", res.smartDiff.trimEnd(), "```");
	else parts.push("", "(nothing behavior-bearing remains after abridging)");
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const MeatParams = Type.Object({
	target: Type.Optional(
		Type.String({
			description:
				"Revision (sha, HEAD~3) or range (sha1..sha2, main...HEAD). Defaults to HEAD.",
		}),
	),
	staged: Type.Optional(
		Type.Boolean({ description: "Abridge the staged changes (git diff --staged)." }),
	),
	worktree: Type.Optional(
		Type.Boolean({ description: "Abridge the unstaged working-tree changes (git diff)." }),
	),
	diff: Type.Optional(
		Type.String({ description: "A unified diff to abridge directly, instead of a git target." }),
	),
	no_cache: Type.Optional(
		Type.Boolean({ description: "Ignore the cached result and recompute." }),
	),
	cwd: Type.Optional(
		Type.String({ description: "Repository directory (defaults to the session cwd)." }),
	),
});

export type MeatToolInput = Static<typeof MeatParams>;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "meat",
		label: "Meat",
		description:
			"Abridge a code diff into a 'reading diff': an LLM drops mechanical noise (batch field " +
			"copies, error-message construction, forced zero-value returns, generated code) and " +
			"keeps only behavior-bearing changes, returning a one-line summary plus the abridged " +
			"unified diff. Use it to review what a commit, range, or staged/working-tree change " +
			"actually does without reading the full diff. Results are cached by meat; repeated " +
			"calls on an unchanged diff are instant.",
		promptSnippet: "Abridge a diff into a reading diff (summary + behavior-bearing hunks only)",
		promptGuidelines: [
			"Use the meat tool instead of reading a raw diff when the user asks what a commit, range, or staged/working-tree change does, or asks for a review of one.",
		],
		parameters: MeatParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cwd = params.cwd ?? ctx.cwd;
			const res = await runMeat(
				{
					target: params.target,
					staged: params.staged,
					worktree: params.worktree,
					diff: params.diff,
					noCache: params.no_cache,
					cwd,
				},
				ctx,
				signal,
				(msg) => onUpdate?.({ content: [{ type: "text", text: msg }], details: {} }),
			);

			const label = invocationLabel({
				target: params.target,
				staged: params.staged,
				worktree: params.worktree,
				diff: params.diff,
				cwd,
			});

			let text = formatMeatText(res, label);
			let fullDiffPath: string | undefined;
			const truncation = truncateHead(res.smartDiff, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			if (truncation.truncated) {
				fullDiffPath = path.join(
					os.tmpdir(),
					`pi-meat-${crypto.randomBytes(4).toString("hex")}.diff`,
				);
				fs.writeFileSync(fullDiffPath, res.smartDiff);
				text = formatMeatText({ ...res, smartDiff: truncation.content }, label);
				text +=
					`\n\n[Reading diff truncated: ${truncation.outputLines} of ${truncation.totalLines} lines` +
					` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).` +
					` Full reading diff saved to: ${fullDiffPath}]`;
			}

			return {
				content: [{ type: "text", text }],
				details: {
					label,
					summary: res.summary,
					elision: res.elision,
					smartDiff: res.smartDiff,
					inputTokens: res.inputTokens,
					outputTokens: res.outputTokens,
					cached: res.cached,
					fullDiffPath,
				},
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const a = args as Partial<MeatToolInput>;
			const label = a.diff !== undefined
				? "stdin diff"
				: a.staged
					? "--staged"
					: a.worktree
						? "--worktree"
						: (a.target ?? "HEAD");
			text.setText(
				theme.fg("toolTitle", theme.bold("meat ")) + theme.fg("muted", label),
			);
			return text;
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (isPartial) {
				text.setText(theme.fg("warning", "meat is reading the diff…"));
				return text;
			}
			const d = result.details as
				| {
						summary?: string;
						smartDiff?: string;
						cached?: boolean;
						inputTokens?: number;
						outputTokens?: number;
				  }
				| undefined;
			if (!d) {
				text.setText(theme.fg("error", "meat failed"));
				return text;
			}
			let out = theme.fg("success", "✓ ") + theme.fg("accent", d.summary ?? "");
			const meta: string[] = [];
			if (d.cached) meta.push("cached");
			if (d.inputTokens || d.outputTokens) {
				meta.push(`in=${d.inputTokens ?? 0} out=${d.outputTokens ?? 0}`);
			}
			if (meta.length) out += theme.fg("dim", `  (${meta.join(", ")})`);
			if (expanded && d.smartDiff) {
				out += "\n" + theme.fg("muted", d.smartDiff.trimEnd());
			}
			text.setText(out);
			return text;
		},
	});

	pi.registerCommand("meat", {
		description:
			"Abridge a change with the active pi session model and add it to the session context. " +
			"Usage: /meat [revision|range] [--staged|--worktree] [--no-cache] (default: HEAD)",
		getArgumentCompletions: (prefix) => {
			const items = ["HEAD", "HEAD~1", "HEAD~3", "--staged", "--worktree", "--no-cache"].map(
				(value) => ({ value, label: value }),
			);
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const inv: MeatInvocation = { cwd: ctx.cwd };
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			for (let i = 0; i < tokens.length; i++) {
				const tok = tokens[i];
				if (tok === "--staged" || tok === "-staged") inv.staged = true;
				else if (tok === "--worktree" || tok === "-w") inv.worktree = true;
				else if (tok === "--no-cache") inv.noCache = true;
				else if (!tok.startsWith("-") && inv.target === undefined) {
					inv.target = tok;
				} else {
					ctx.ui.notify(`meat: ignoring unrecognized argument ${tok}`, "warning");
				}
			}

			const label = invocationLabel(inv);
			ctx.ui.setStatus("pi-meat", `meat: reading ${label}…`);
			try {
				const res = await runMeat(inv, ctx, ctx.signal, (msg) =>
					ctx.ui.setStatus("pi-meat", `meat: ${msg}`),
				);
				pi.sendMessage(
					{
						customType: "pi-meat:reading-diff",
						content: formatMeatText(res, label),
						display: true,
						details: {
							label,
							summary: res.summary,
							smartDiff: res.smartDiff,
							cached: res.cached,
						},
					},
					{ deliverAs: "nextTurn" },
				);
				ctx.ui.notify(
					`meat: ${res.summary} — reading diff added to context${res.cached ? " (cached)" : ""}`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			} finally {
				ctx.ui.setStatus("pi-meat", "");
			}
		},
	});
}
