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
import { Text } from "@earendil-works/pi-tui";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	abridgeWithActiveModel,
	meatInvocationLabel as invocationLabel,
	type MeatAbridgeRequest as MeatInvocation,
	type MeatAbridgeResult as MeatResult,
} from "./api.js";
import { Type, type Static } from "typebox";

async function runMeat(
	invocation: MeatInvocation,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	onUpdate?: (message: string) => void,
): Promise<MeatResult> {
	return abridgeWithActiveModel(ctx, invocation, { signal, onProgress: onUpdate });
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
