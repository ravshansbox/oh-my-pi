import { readFileSync, type Stats, statSync } from "node:fs";
import nodePath from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { Type } from "@sinclair/typebox";
import type { Subprocess } from "bun";
import { getLanguageFromPath, type Theme } from "../../modes/interactive/theme/theme";
import grepDescription from "../../prompts/tools/grep.md" with { type: "text" };
import { ensureTool } from "../../utils/tools-manager";
import type { RenderResultOptions } from "../custom-tools/types";
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
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	type: Type.Optional(Type.String({ description: "File type filter (e.g., 'ts', 'rust', 'py')" })),
	ignoreCase: Type.Optional(
		Type.Boolean({ description: "Force case-insensitive search (default: false, uses smart-case otherwise)" }),
	),
	caseSensitive: Type.Optional(
		Type.Boolean({ description: "Force case-sensitive search (default: false, disables smart-case)" }),
	),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	multiline: Type.Optional(
		Type.Boolean({ description: "Enable multiline matching for cross-line patterns (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
	outputMode: Type.Optional(
		Type.Union([Type.Literal("content"), Type.Literal("files_with_matches"), Type.Literal("count")], {
			description:
				"Output mode: 'content' shows matching lines, 'files_with_matches' shows only file paths, 'count' shows match counts per file (default: 'content')",
		}),
	),
	headLimit: Type.Optional(Type.Number({ description: "Limit output to first N results (default: unlimited)" })),
	offset: Type.Optional(Type.Number({ description: "Skip first N results before applying headLimit (default: 0)" })),
});

const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	headLimitReached?: number;
	linesTruncated?: boolean;
	// Fields for TUI rendering
	scopePath?: string;
	matchCount?: number;
	fileCount?: number;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	mode?: "content" | "files_with_matches" | "count";
	truncated?: boolean;
	error?: string;
}

export function createGrepTool(cwd: string): AgentTool<typeof grepSchema> {
	return {
		name: "grep",
		label: "Grep",
		description: grepDescription,
		parameters: grepSchema,
		execute: async (
			_toolCallId: string,
			{
				pattern,
				path: searchDir,
				glob,
				type,
				ignoreCase,
				caseSensitive,
				literal,
				multiline,
				context,
				limit,
				outputMode,
				headLimit,
				offset,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				type?: string;
				ignoreCase?: boolean;
				caseSensitive?: boolean;
				literal?: boolean;
				multiline?: boolean;
				context?: number;
				limit?: number;
				outputMode?: "content" | "files_with_matches" | "count";
				headLimit?: number;
				offset?: number;
			},
			signal?: AbortSignal,
		) => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const rgPath = await ensureTool("rg", true);
			if (!rgPath) {
				throw new Error("ripgrep (rg) is not available and could not be downloaded");
			}

			const searchPath = resolveToCwd(searchDir || ".", cwd);
			const scopePath = (() => {
				const relative = nodePath.relative(cwd, searchPath).replace(/\\/g, "/");
				return relative.length === 0 ? "." : relative;
			})();
			let searchStat: Stats;
			try {
				searchStat = statSync(searchPath);
			} catch (_err) {
				throw new Error(`Path not found: ${searchPath}`);
			}

			const isDirectory = searchStat.isDirectory();
			const contextValue = context && context > 0 ? context : 0;
			const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
			const effectiveOutputMode = outputMode ?? "content";
			const effectiveOffset = offset && offset > 0 ? offset : 0;
			const hasHeadLimit = headLimit !== undefined && headLimit > 0;

			const formatPath = (filePath: string): string => {
				if (isDirectory) {
					const relative = nodePath.relative(searchPath, filePath);
					if (relative && !relative.startsWith("..")) {
						return relative.replace(/\\/g, "/");
					}
				}
				return nodePath.basename(filePath);
			};

			const fileCache = new Map<string, string[]>();
			const getFileLines = (filePath: string): string[] => {
				let lines = fileCache.get(filePath);
				if (!lines) {
					try {
						const content = readFileSync(filePath, "utf-8");
						lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
					} catch {
						lines = [];
					}
					fileCache.set(filePath, lines);
				}
				return lines;
			};

			const args: string[] = [];

			// Base arguments depend on output mode
			if (effectiveOutputMode === "files_with_matches") {
				args.push("--files-with-matches", "--color=never", "--hidden");
			} else if (effectiveOutputMode === "count") {
				args.push("--count", "--color=never", "--hidden");
			} else {
				args.push("--json", "--line-number", "--color=never", "--hidden");
			}

			if (caseSensitive) {
				args.push("--case-sensitive");
			} else if (ignoreCase) {
				args.push("--ignore-case");
			} else {
				args.push("--smart-case");
			}

			if (multiline) {
				args.push("--multiline");
			}

			if (literal) {
				args.push("--fixed-strings");
			}

			if (glob) {
				args.push("--glob", glob);
			}

			if (type) {
				args.push("--type", type);
			}

			args.push(pattern, searchPath);

			const child: Subprocess = Bun.spawn([rgPath, ...args], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});

			let stderr = "";
			let matchCount = 0;
			let matchLimitReached = false;
			let linesTruncated = false;
			let aborted = false;
			let killedDueToLimit = false;
			const outputLines: string[] = [];
			const files = new Set<string>();
			const fileList: string[] = [];
			const fileMatchCounts = new Map<string, number>();

			const recordFile = (filePath: string) => {
				const relative = formatPath(filePath);
				if (!files.has(relative)) {
					files.add(relative);
					fileList.push(relative);
				}
			};

			const recordFileMatch = (filePath: string) => {
				const relative = formatPath(filePath);
				fileMatchCounts.set(relative, (fileMatchCounts.get(relative) ?? 0) + 1);
			};

			const stopChild = (dueToLimit: boolean = false) => {
				killedDueToLimit = dueToLimit;
				child.kill();
			};

			const onAbort = () => {
				aborted = true;
				stopChild();
			};

			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}

			// For simple output modes (files_with_matches, count), process text directly
			if (effectiveOutputMode === "files_with_matches" || effectiveOutputMode === "count") {
				const stdoutReader = (child.stdout as ReadableStream<Uint8Array>).getReader();
				const stderrReader = (child.stderr as ReadableStream<Uint8Array>).getReader();
				const decoder = new TextDecoder();
				let stdout = "";

				await Promise.all([
					(async () => {
						while (true) {
							const { done, value } = await stdoutReader.read();
							if (done) break;
							stdout += decoder.decode(value, { stream: true });
						}
					})(),
					(async () => {
						while (true) {
							const { done, value } = await stderrReader.read();
							if (done) break;
							stderr += decoder.decode(value, { stream: true });
						}
					})(),
				]);

				const exitCode = await child.exited;

				if (signal) {
					signal.removeEventListener("abort", onAbort);
				}

				if (aborted) {
					throw new Error("Operation aborted");
				}

				if (exitCode !== 0 && exitCode !== 1) {
					const errorMsg = stderr.trim() || `ripgrep exited with code ${exitCode}`;
					throw new Error(errorMsg);
				}

				const lines = stdout
					.trim()
					.split("\n")
					.filter((line) => line.length > 0);

				if (lines.length === 0) {
					return {
						content: [{ type: "text", text: "No matches found" }],
						details: {
							scopePath,
							matchCount: 0,
							fileCount: 0,
							files: [],
							mode: effectiveOutputMode,
							truncated: false,
						},
					};
				}

				// Apply offset and headLimit
				let processedLines = lines;
				if (effectiveOffset > 0) {
					processedLines = processedLines.slice(effectiveOffset);
				}
				if (hasHeadLimit) {
					processedLines = processedLines.slice(0, headLimit);
				}

				let simpleMatchCount = 0;
				let fileCount = 0;
				const simpleFiles = new Set<string>();
				const simpleFileList: string[] = [];
				const simpleFileMatchCounts = new Map<string, number>();

				const recordSimpleFile = (filePath: string) => {
					const relative = formatPath(filePath);
					if (!simpleFiles.has(relative)) {
						simpleFiles.add(relative);
						simpleFileList.push(relative);
					}
				};

				const recordSimpleFileMatch = (filePath: string, count: number) => {
					const relative = formatPath(filePath);
					simpleFileMatchCounts.set(relative, count);
				};

				if (effectiveOutputMode === "files_with_matches") {
					for (const line of lines) {
						recordSimpleFile(line);
					}
					fileCount = simpleFiles.size;
					simpleMatchCount = fileCount;
				} else {
					for (const line of lines) {
						const separatorIndex = line.lastIndexOf(":");
						const filePart = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
						const countPart = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
						const count = Number.parseInt(countPart, 10);
						recordSimpleFile(filePart);
						if (!Number.isNaN(count)) {
							simpleMatchCount += count;
							recordSimpleFileMatch(filePart, count);
						}
					}
					fileCount = simpleFiles.size;
				}

				const truncatedByHeadLimit = hasHeadLimit && processedLines.length < lines.length;

				// For count mode, format as "path:count"
				if (effectiveOutputMode === "count") {
					const formatted = processedLines.map((line) => {
						const separatorIndex = line.lastIndexOf(":");
						const relative = formatPath(separatorIndex === -1 ? line : line.slice(0, separatorIndex));
						const count = separatorIndex === -1 ? "0" : line.slice(separatorIndex + 1);
						return `${relative}:${count}`;
					});
					const output = formatted.join("\n");
					return {
						content: [{ type: "text", text: output }],
						details: {
							scopePath,
							matchCount: simpleMatchCount,
							fileCount,
							files: simpleFileList,
							fileMatches: simpleFileList.map((path) => ({
								path,
								count: simpleFileMatchCounts.get(path) ?? 0,
							})),
							mode: effectiveOutputMode,
							truncated: truncatedByHeadLimit,
							headLimitReached: truncatedByHeadLimit ? headLimit : undefined,
						},
					};
				}

				// For files_with_matches, format paths
				const formatted = processedLines.map((line) => formatPath(line));
				const output = formatted.join("\n");
				return {
					content: [{ type: "text", text: output }],
					details: {
						scopePath,
						matchCount: simpleMatchCount,
						fileCount,
						files: simpleFileList,
						mode: effectiveOutputMode,
						truncated: truncatedByHeadLimit,
						headLimitReached: truncatedByHeadLimit ? headLimit : undefined,
					},
				};
			}

			// Content mode - existing JSON processing
			const formatBlock = (filePath: string, lineNumber: number): string[] => {
				const relativePath = formatPath(filePath);
				const lines = getFileLines(filePath);
				if (!lines.length) {
					return [`${relativePath}:${lineNumber}: (unable to read file)`];
				}

				const block: string[] = [];
				const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
				const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;

				for (let current = start; current <= end; current++) {
					const lineText = lines[current - 1] ?? "";
					const sanitized = lineText.replace(/\r/g, "");
					const isMatchLine = current === lineNumber;

					const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
					if (wasTruncated) {
						linesTruncated = true;
					}

					if (isMatchLine) {
						block.push(`${relativePath}:${current}: ${truncatedText}`);
					} else {
						block.push(`${relativePath}-${current}- ${truncatedText}`);
					}
				}

				return block;
			};

			const processLine = (line: string) => {
				if (!line.trim() || matchCount >= effectiveLimit) {
					return;
				}

				let event: { type: string; data?: { path?: { text?: string }; line_number?: number } };
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "match") {
					matchCount++;
					const filePath = event.data?.path?.text;
					const lineNumber = event.data?.line_number;

					if (filePath && typeof lineNumber === "number") {
						recordFile(filePath);
						recordFileMatch(filePath);
						outputLines.push(...formatBlock(filePath, lineNumber));
					}

					if (matchCount >= effectiveLimit) {
						matchLimitReached = true;
						stopChild(true);
					}
				}
			};

			// Read streams using Bun's ReadableStream API
			const stdoutReader = (child.stdout as ReadableStream<Uint8Array>).getReader();
			const stderrReader = (child.stderr as ReadableStream<Uint8Array>).getReader();
			const decoder = new TextDecoder();
			let stdoutBuffer = "";

			await Promise.all([
				// Process stdout line by line
				(async () => {
					while (true) {
						const { done, value } = await stdoutReader.read();
						if (done) break;

						stdoutBuffer += decoder.decode(value, { stream: true });
						const lines = stdoutBuffer.split("\n");
						// Keep the last incomplete line in the buffer
						stdoutBuffer = lines.pop() ?? "";

						for (const line of lines) {
							processLine(line);
						}
					}
					// Process any remaining content
					if (stdoutBuffer.trim()) {
						processLine(stdoutBuffer);
					}
				})(),
				// Collect stderr
				(async () => {
					while (true) {
						const { done, value } = await stderrReader.read();
						if (done) break;
						stderr += decoder.decode(value, { stream: true });
					}
				})(),
			]);

			const exitCode = await child.exited;

			// Cleanup
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}

			if (aborted) {
				throw new Error("Operation aborted");
			}

			if (!killedDueToLimit && exitCode !== 0 && exitCode !== 1) {
				const errorMsg = stderr.trim() || `ripgrep exited with code ${exitCode}`;
				throw new Error(errorMsg);
			}

			if (matchCount === 0) {
				return {
					content: [{ type: "text", text: "No matches found" }],
					details: {
						scopePath,
						matchCount: 0,
						fileCount: 0,
						files: [],
						mode: effectiveOutputMode,
						truncated: false,
					},
				};
			}

			// Apply offset and headLimit to output lines
			let processedLines = outputLines;
			if (effectiveOffset > 0) {
				processedLines = processedLines.slice(effectiveOffset);
			}
			if (hasHeadLimit) {
				processedLines = processedLines.slice(0, headLimit);
			}

			// Apply byte truncation (no line limit since we already have match limit)
			const rawOutput = processedLines.join("\n");
			const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

			let output = truncation.content;
			const truncatedByHeadLimit = hasHeadLimit && processedLines.length < outputLines.length;
			const details: GrepToolDetails = {
				scopePath,
				matchCount,
				fileCount: files.size,
				files: fileList,
				fileMatches: fileList.map((path) => ({
					path,
					count: fileMatchCounts.get(path) ?? 0,
				})),
				mode: effectiveOutputMode,
				truncated: matchLimitReached || truncation.truncated || truncatedByHeadLimit,
				headLimitReached: truncatedByHeadLimit ? headLimit : undefined,
			};

			// Build notices
			const notices: string[] = [];

			if (matchLimitReached) {
				notices.push(
					`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
				);
				details.matchLimitReached = effectiveLimit;
			}

			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}

			if (linesTruncated) {
				notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
				details.linesTruncated = true;
			}

			if (notices.length > 0) {
				output += `\n\n[${notices.join(". ")}]`;
			}

			return {
				content: [{ type: "text", text: output }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
	};
}

/** Default grep tool using process.cwd() - for backwards compatibility */
export const grepTool = createGrepTool(process.cwd());

// =============================================================================
// TUI Renderer
// =============================================================================

interface GrepRenderArgs {
	pattern: string;
	path?: string;
	glob?: string;
	type?: string;
	ignoreCase?: boolean;
	caseSensitive?: boolean;
	literal?: boolean;
	multiline?: boolean;
	context?: number;
	limit?: number;
	outputMode?: string;
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;
const COLLAPSED_TEXT_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

export const grepToolRenderer = {
	renderCall(args: GrepRenderArgs, uiTheme: Theme): Component {
		const label = uiTheme.fg("toolTitle", uiTheme.bold("Grep"));
		let text = `${label} ${uiTheme.fg("accent", args.pattern || "?")}`;

		const meta: string[] = [];
		if (args.path) meta.push(`in ${args.path}`);
		if (args.glob) meta.push(`glob:${args.glob}`);
		if (args.type) meta.push(`type:${args.type}`);
		if (args.outputMode && args.outputMode !== "files_with_matches") meta.push(`mode:${args.outputMode}`);
		if (args.caseSensitive) {
			meta.push("case:sensitive");
		} else if (args.ignoreCase) {
			meta.push("case:insensitive");
		}
		if (args.literal) meta.push("literal");
		if (args.multiline) meta.push("multiline");
		if (args.context !== undefined) meta.push(`context:${args.context}`);
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);

		text += formatMeta(meta, uiTheme);

		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GrepToolDetails },
		{ expanded }: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const details = result.details;

		if (details?.error) {
			return new Text(formatErrorMessage(details.error, uiTheme), 0, 0);
		}

		const hasDetailedData = details?.matchCount !== undefined || details?.fileCount !== undefined;

		if (!hasDetailedData) {
			const textContent = result.content?.find((c) => c.type === "text")?.text;
			if (!textContent || textContent === "No matches found") {
				return new Text(formatEmptyMessage("No matches found", uiTheme), 0, 0);
			}

			const lines = textContent.split("\n").filter((line) => line.trim() !== "");
			const maxLines = expanded ? lines.length : Math.min(lines.length, COLLAPSED_TEXT_LIMIT);
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;
			const hasMore = remaining > 0;

			const icon = uiTheme.styledSymbol("status.success", "success");
			const summary = formatCount("item", lines.length);
			const expandHint = formatExpandHint(expanded, hasMore, uiTheme);
			let text = `${icon} ${uiTheme.fg("dim", summary)}${expandHint}`;

			for (let i = 0; i < displayLines.length; i++) {
				const isLast = i === displayLines.length - 1 && remaining === 0;
				const branch = isLast ? uiTheme.tree.last : uiTheme.tree.branch;
				text += `\n ${uiTheme.fg("dim", branch)} ${uiTheme.fg("toolOutput", displayLines[i])}`;
			}

			if (remaining > 0) {
				text += `\n ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg(
					"muted",
					formatMoreItems(remaining, "item", uiTheme),
				)}`;
			}

			return new Text(text, 0, 0);
		}

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const mode = details?.mode ?? "files_with_matches";
		const truncated = details?.truncated ?? details?.truncation?.truncated ?? false;
		const files = details?.files ?? [];

		if (matchCount === 0) {
			return new Text(formatEmptyMessage("No matches found", uiTheme), 0, 0);
		}

		const icon = uiTheme.styledSymbol("status.success", "success");
		const summaryParts =
			mode === "files_with_matches"
				? [formatCount("file", fileCount)]
				: [formatCount("match", matchCount), formatCount("file", fileCount)];
		const summaryText = summaryParts.join(uiTheme.sep.dot);
		const scopeLabel = formatScope(details?.scopePath, uiTheme);

		const fileEntries: Array<{ path: string; count?: number }> = details?.fileMatches?.length
			? details.fileMatches.map((entry) => ({ path: entry.path, count: entry.count }))
			: files.map((path) => ({ path }));
		const maxFiles = expanded ? fileEntries.length : Math.min(fileEntries.length, COLLAPSED_LIST_LIMIT);
		const hasMoreFiles = fileEntries.length > maxFiles;
		const expandHint = formatExpandHint(expanded, hasMoreFiles, uiTheme);

		let text = `${icon} ${uiTheme.fg("dim", summaryText)}${formatTruncationSuffix(
			truncated,
			uiTheme,
		)}${scopeLabel}${expandHint}`;

		const truncationReasons: string[] = [];
		if (details?.matchLimitReached) {
			truncationReasons.push(`limit ${details.matchLimitReached} matches`);
		}
		if (details?.headLimitReached) {
			truncationReasons.push(`head limit ${details.headLimitReached}`);
		}
		if (details?.truncation?.truncated) {
			truncationReasons.push("size limit");
		}
		if (details?.linesTruncated) {
			truncationReasons.push("line length");
		}

		const hasTruncation = truncationReasons.length > 0;

		if (fileEntries.length > 0) {
			for (let i = 0; i < maxFiles; i++) {
				const entry = fileEntries[i];
				const isLast = i === maxFiles - 1 && !hasMoreFiles && !hasTruncation;
				const branch = isLast ? uiTheme.tree.last : uiTheme.tree.branch;
				const isDir = entry.path.endsWith("/");
				const entryPath = isDir ? entry.path.slice(0, -1) : entry.path;
				const lang = isDir ? undefined : getLanguageFromPath(entryPath);
				const entryIcon = isDir
					? uiTheme.fg("accent", uiTheme.icon.folder)
					: uiTheme.fg("muted", uiTheme.getLangIcon(lang));
				const countLabel =
					entry.count !== undefined
						? ` ${uiTheme.fg("dim", `(${entry.count} match${entry.count !== 1 ? "es" : ""})`)}`
						: "";
				text += `\n ${uiTheme.fg("dim", branch)} ${entryIcon} ${uiTheme.fg("accent", entry.path)}${countLabel}`;
			}

			if (hasMoreFiles) {
				const moreFilesBranch = hasTruncation ? uiTheme.tree.branch : uiTheme.tree.last;
				text += `\n ${uiTheme.fg("dim", moreFilesBranch)} ${uiTheme.fg(
					"muted",
					formatMoreItems(fileEntries.length - maxFiles, "file", uiTheme),
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
