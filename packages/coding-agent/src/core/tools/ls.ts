import { existsSync, readdirSync, statSync } from "node:fs";
import nodePath from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { untilAborted } from "../utils";
import { resolveToCwd } from "./path-utils";
import { formatAge } from "./render-utils";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate";

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

const DEFAULT_LIMIT = 500;

export interface LsToolDetails {
	entries?: string[];
	dirCount?: number;
	fileCount?: number;
	truncation?: TruncationResult;
	truncationReasons?: Array<"entryLimit" | "byteLimit">;
	entryLimitReached?: number;
}

export function createLsTool(cwd: string): AgentTool<typeof lsSchema> {
	return {
		name: "ls",
		label: "Ls",
		description: `List directory contents with modification times. Returns entries sorted alphabetically, with '/' suffix for directories and relative age (e.g., "2d ago", "just now"). Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).`,
		parameters: lsSchema,
		execute: async (
			_toolCallId: string,
			{ path, limit }: { path?: string; limit?: number },
			signal?: AbortSignal,
		) => {
			return untilAborted(signal, async () => {
				const dirPath = resolveToCwd(path || ".", cwd);
				const effectiveLimit = limit ?? DEFAULT_LIMIT;

				// Check if path exists
				if (!existsSync(dirPath)) {
					throw new Error(`Path not found: ${dirPath}`);
				}

				// Check if path is a directory
				const stat = statSync(dirPath);
				if (!stat.isDirectory()) {
					throw new Error(`Not a directory: ${dirPath}`);
				}

				// Read directory entries
				let entries: string[];
				try {
					entries = readdirSync(dirPath);
				} catch (e: any) {
					throw new Error(`Cannot read directory: ${e.message}`);
				}

				// Sort alphabetically (case-insensitive)
				entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

				// Format entries with directory indicators
				const results: string[] = [];
				let entryLimitReached = false;
				let dirCount = 0;
				let fileCount = 0;

				for (const entry of entries) {
					if (results.length >= effectiveLimit) {
						entryLimitReached = true;
						break;
					}

					const fullPath = nodePath.join(dirPath, entry);
					let suffix = "";
					let age = "";

					try {
						const entryStat = statSync(fullPath);
						if (entryStat.isDirectory()) {
							suffix = "/";
							dirCount += 1;
						} else {
							fileCount += 1;
						}
						// Calculate age from mtime
						const ageSeconds = Math.floor((Date.now() - entryStat.mtimeMs) / 1000);
						age = formatAge(ageSeconds);
					} catch {
						// Skip entries we can't stat
						continue;
					}

					// Format: "name/ (2d ago)" or "name (just now)"
					const line = age ? `${entry}${suffix} (${age})` : entry + suffix;
					results.push(line);
				}

				if (results.length === 0) {
					return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
				}

				// Apply byte truncation (no line limit since we already have entry limit)
				const rawOutput = results.join("\n");
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

				let output = truncation.content;
				const details: LsToolDetails = {
					entries: results,
					dirCount,
					fileCount,
				};
				const truncationReasons: Array<"entryLimit" | "byteLimit"> = [];

				// Build notices
				const notices: string[] = [];

				if (entryLimitReached) {
					notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
					details.entryLimitReached = effectiveLimit;
					truncationReasons.push("entryLimit");
				}

				if (truncation.truncated) {
					notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
					details.truncation = truncation;
					truncationReasons.push("byteLimit");
				}

				if (truncationReasons.length > 0) {
					details.truncationReasons = truncationReasons;
				}

				if (notices.length > 0) {
					output += `\n\n[${notices.join(". ")}]`;
				}

				return {
					content: [{ type: "text", text: output }],
					details,
				};
			});
		},
	};
}

/** Default ls tool using process.cwd() - for backwards compatibility */
export const lsTool = createLsTool(process.cwd());
