import { existsSync, type Stats, statSync } from "node:fs";
import path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { Type } from "@sinclair/typebox";
import { globSync } from "glob";
import { getLanguageFromPath, type Theme } from "../../modes/interactive/theme/theme";
import findDescription from "../../prompts/tools/find.md" with { type: "text" };
import { ensureTool } from "../../utils/tools-manager";
import type { RenderResultOptions } from "../custom-tools/types";
import { untilAborted } from "../utils";
import { resolveToCwd } from "./path-utils";
import {
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	formatExpandHint,
	formatMeta,
	formatMoreItems,
	formatScope,
	formatTruncationSuffix,
	PREVIEW_LIMITS,
} from "./render-utils";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate";

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
	hidden: Type.Optional(Type.Boolean({ description: "Include hidden files (default: false)" })),
	sortByMtime: Type.Optional(
		Type.Boolean({ description: "Sort results by modification time, most recent first (default: false)" }),
	),
	type: Type.Optional(
		Type.Union([Type.Literal("file"), Type.Literal("dir"), Type.Literal("all")], {
			description:
				"Filter by type: 'file' for files only, 'dir' for directories only, 'all' for both (default: 'all')",
		}),
	),
});

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	// Fields for TUI rendering
	scopePath?: string;
	fileCount?: number;
	files?: string[];
	truncated?: boolean;
	error?: string;
}

export function createFindTool(cwd: string): AgentTool<typeof findSchema> {
	return {
		name: "find",
		label: "Find",
		description: findDescription,
		parameters: findSchema,
		execute: async (
			_toolCallId: string,
			{
				pattern,
				path: searchDir,
				limit,
				hidden,
				sortByMtime,
				type,
			}: {
				pattern: string;
				path?: string;
				limit?: number;
				hidden?: boolean;
				sortByMtime?: boolean;
				type?: "file" | "dir" | "all";
			},
			signal?: AbortSignal,
		) => {
			return untilAborted(signal, async () => {
				// Ensure fd is available
				const fdPath = await ensureTool("fd", true);
				if (!fdPath) {
					throw new Error("fd is not available and could not be downloaded");
				}

				const searchPath = resolveToCwd(searchDir || ".", cwd);
				const scopePath = (() => {
					const relative = path.relative(cwd, searchPath).replace(/\\/g, "/");
					return relative.length === 0 ? "." : relative;
				})();
				const effectiveLimit = limit ?? DEFAULT_LIMIT;
				const effectiveType = type ?? "all";
				const includeHidden = hidden ?? false;
				const shouldSortByMtime = sortByMtime ?? false;

				// Build fd arguments
				// When pattern contains path separators (e.g. "reports/**"), use --full-path
				// so fd matches against the full path, not just the filename.
				// Also prepend **/ to anchor the pattern at any depth in the search path.
				const hasPathSeparator = pattern.includes("/") || pattern.includes("\\");
				const effectivePattern = hasPathSeparator && !pattern.startsWith("**/") ? `**/${pattern}` : pattern;
				const args: string[] = [
					"--glob", // Use glob pattern
					...(hasPathSeparator ? ["--full-path"] : []),
					"--color=never", // No ANSI colors
					"--max-results",
					String(effectiveLimit),
				];

				if (includeHidden) {
					args.push("--hidden");
				}

				// Add type filter
				if (effectiveType === "file") {
					args.push("--type", "f");
				} else if (effectiveType === "dir") {
					args.push("--type", "d");
				}

				// Include .gitignore files (root + nested) so fd respects them even outside git repos
				const gitignoreFiles = new Set<string>();
				const rootGitignore = path.join(searchPath, ".gitignore");
				if (existsSync(rootGitignore)) {
					gitignoreFiles.add(rootGitignore);
				}

				try {
					const nestedGitignores = globSync("**/.gitignore", {
						cwd: searchPath,
						dot: true,
						absolute: true,
						ignore: ["**/node_modules/**", "**/.git/**"],
					});
					for (const file of nestedGitignores) {
						gitignoreFiles.add(file);
					}
				} catch {
					// Ignore glob errors
				}

				for (const gitignorePath of gitignoreFiles) {
					args.push("--ignore-file", gitignorePath);
				}

				// Pattern and path
				args.push(effectivePattern, searchPath);

				// Run fd
				const result = Bun.spawnSync([fdPath, ...args], {
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});

				const output = result.stdout.toString().trim();

				if (result.exitCode !== 0) {
					const errorMsg = result.stderr.toString().trim() || `fd exited with code ${result.exitCode}`;
					// fd returns non-zero for some errors but may still have partial output
					if (!output) {
						throw new Error(errorMsg);
					}
				}

				if (!output) {
					return {
						content: [{ type: "text", text: "No files found matching pattern" }],
						details: { scopePath, fileCount: 0, files: [], truncated: false },
					};
				}

				const lines = output.split("\n");
				const relativized: string[] = [];
				const mtimes: number[] = [];

				for (const rawLine of lines) {
					const line = rawLine.replace(/\r$/, "").trim();
					if (!line) {
						continue;
					}

					const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
					let relativePath = line;
					if (line.startsWith(searchPath)) {
						relativePath = line.slice(searchPath.length + 1); // +1 for the /
					} else {
						relativePath = path.relative(searchPath, line);
					}

					if (hadTrailingSlash && !relativePath.endsWith("/")) {
						relativePath += "/";
					}

					relativized.push(relativePath);

					// Collect mtime if sorting is requested
					if (shouldSortByMtime) {
						try {
							const fullPath = path.join(searchPath, relativePath);
							const stat: Stats = statSync(fullPath);
							mtimes.push(stat.mtimeMs);
						} catch {
							mtimes.push(0);
						}
					}
				}

				// Sort by mtime if requested (most recent first)
				if (shouldSortByMtime && relativized.length > 0) {
					const indexed = relativized.map((path, idx) => ({ path, mtime: mtimes[idx] || 0 }));
					indexed.sort((a, b) => b.mtime - a.mtime);
					relativized.length = 0;
					relativized.push(...indexed.map((item) => item.path));
				}

				// Check if we hit the result limit
				const resultLimitReached = relativized.length >= effectiveLimit;

				// Apply byte truncation (no line limit since we already have result limit)
				const rawOutput = relativized.join("\n");
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

				let resultOutput = truncation.content;
				const details: FindToolDetails = {
					scopePath,
					fileCount: relativized.length,
					files: relativized,
					truncated: resultLimitReached || truncation.truncated,
				};

				// Build notices
				const notices: string[] = [];

				if (resultLimitReached) {
					notices.push(
						`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
					);
					details.resultLimitReached = effectiveLimit;
				}

				if (truncation.truncated) {
					notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
					details.truncation = truncation;
				}

				if (notices.length > 0) {
					resultOutput += `\n\n[${notices.join(". ")}]`;
				}

				return {
					content: [{ type: "text", text: resultOutput }],
					details: Object.keys(details).length > 0 ? details : undefined,
				};
			});
		},
	};
}

/** Default find tool using process.cwd() - for backwards compatibility */
export const findTool = createFindTool(process.cwd());

// =============================================================================
// TUI Renderer
// =============================================================================

interface FindRenderArgs {
	pattern: string;
	path?: string;
	type?: string;
	hidden?: boolean;
	sortByMtime?: boolean;
	limit?: number;
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;

export const findToolRenderer = {
	renderCall(args: FindRenderArgs, uiTheme: Theme): Component {
		const label = uiTheme.fg("toolTitle", uiTheme.bold("Find"));
		let text = `${label} ${uiTheme.fg("accent", args.pattern || "*")}`;

		const meta: string[] = [];
		if (args.path) meta.push(`in ${args.path}`);
		if (args.type && args.type !== "all") meta.push(`type:${args.type}`);
		if (args.hidden) meta.push("hidden");
		if (args.sortByMtime) meta.push("sort:mtime");
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);

		text += formatMeta(meta, uiTheme);

		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: FindToolDetails },
		{ expanded }: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const details = result.details;

		if (details?.error) {
			return new Text(formatErrorMessage(details.error, uiTheme), 0, 0);
		}

		const hasDetailedData = details?.fileCount !== undefined;
		const textContent = result.content?.find((c) => c.type === "text")?.text;

		if (!hasDetailedData) {
			if (!textContent || textContent.includes("No files matching") || textContent.trim() === "") {
				return new Text(formatEmptyMessage("No files found", uiTheme), 0, 0);
			}

			const lines = textContent.split("\n").filter((l) => l.trim());
			const maxLines = expanded ? lines.length : Math.min(lines.length, COLLAPSED_LIST_LIMIT);
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;
			const hasMore = remaining > 0;

			const icon = uiTheme.styledSymbol("status.success", "success");
			const summary = formatCount("file", lines.length);
			const expandHint = formatExpandHint(expanded, hasMore, uiTheme);
			let text = `${icon} ${uiTheme.fg("dim", summary)}${expandHint}`;

			for (let i = 0; i < displayLines.length; i++) {
				const isLast = i === displayLines.length - 1 && remaining === 0;
				const branch = isLast ? uiTheme.tree.last : uiTheme.tree.branch;
				text += `\n ${uiTheme.fg("dim", branch)} ${uiTheme.fg("accent", displayLines[i])}`;
			}
			if (remaining > 0) {
				text += `\n ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg(
					"muted",
					formatMoreItems(remaining, "file", uiTheme),
				)}`;
			}
			return new Text(text, 0, 0);
		}

		const fileCount = details?.fileCount ?? 0;
		const truncated = details?.truncated ?? details?.truncation?.truncated ?? false;
		const files = details?.files ?? [];

		if (fileCount === 0) {
			return new Text(formatEmptyMessage("No files found", uiTheme), 0, 0);
		}

		const icon = uiTheme.styledSymbol("status.success", "success");
		const summaryText = formatCount("file", fileCount);
		const scopeLabel = formatScope(details?.scopePath, uiTheme);
		const maxFiles = expanded ? files.length : Math.min(files.length, COLLAPSED_LIST_LIMIT);
		const hasMoreFiles = files.length > maxFiles;
		const expandHint = formatExpandHint(expanded, hasMoreFiles, uiTheme);

		let text = `${icon} ${uiTheme.fg("dim", summaryText)}${formatTruncationSuffix(
			truncated,
			uiTheme,
		)}${scopeLabel}${expandHint}`;

		const truncationReasons: string[] = [];
		if (details?.resultLimitReached) {
			truncationReasons.push(`limit ${details.resultLimitReached} results`);
		}
		if (details?.truncation?.truncated) {
			truncationReasons.push("size limit");
		}

		const hasTruncation = truncationReasons.length > 0;

		if (files.length > 0) {
			for (let i = 0; i < maxFiles; i++) {
				const isLast = i === maxFiles - 1 && !hasMoreFiles && !hasTruncation;
				const branch = isLast ? uiTheme.tree.last : uiTheme.tree.branch;
				const entry = files[i];
				const isDir = entry.endsWith("/");
				const entryPath = isDir ? entry.slice(0, -1) : entry;
				const lang = isDir ? undefined : getLanguageFromPath(entryPath);
				const entryIcon = isDir
					? uiTheme.fg("accent", uiTheme.icon.folder)
					: uiTheme.fg("muted", uiTheme.getLangIcon(lang));
				text += `\n ${uiTheme.fg("dim", branch)} ${entryIcon} ${uiTheme.fg("accent", entry)}`;
			}

			if (hasMoreFiles) {
				const moreFilesBranch = hasTruncation ? uiTheme.tree.branch : uiTheme.tree.last;
				text += `\n ${uiTheme.fg("dim", moreFilesBranch)} ${uiTheme.fg(
					"muted",
					formatMoreItems(files.length - maxFiles, "file", uiTheme),
				)}`;
			}
		}

		if (hasTruncation) {
			text += `\n ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg(
				"warning",
				`truncated: ${truncationReasons.join(", ")}`,
			)}`;
		}

		return new Text(text, 0, 0);
	},
};
