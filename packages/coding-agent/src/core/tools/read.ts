import { spawnSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { Type } from "@sinclair/typebox";
import { globSync } from "glob";
import readDescription from "../../prompts/tools/read.md" with { type: "text" };
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime";
import { ensureTool } from "../../utils/tools-manager";
import { untilAborted } from "../utils";
import { createLsTool } from "./ls";
import { resolveReadPath, resolveToCwd } from "./path-utils";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate";

// Document types convertible via markitdown
const CONVERTIBLE_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".rtf", ".epub"]);

// Maximum image file size (20MB) - larger images will be rejected to prevent OOM during serialization
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
const MAX_FUZZY_RESULTS = 5;
const MAX_FUZZY_CANDIDATES = 20000;
const MIN_BASE_SIMILARITY = 0.5;
const MIN_FULL_SIMILARITY = 0.6;

function normalizePathForMatch(value: string): string {
	return value
		.replace(/\\/g, "/")
		.replace(/^\.\/+/, "")
		.replace(/\/+$/, "")
		.toLowerCase();
}

function isNotFoundError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = (error as { code?: string }).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function isPathWithin(basePath: string, targetPath: string): boolean {
	const relativePath = path.relative(basePath, targetPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function findExistingDirectory(startDir: string): Promise<string | null> {
	let current = startDir;
	const root = path.parse(startDir).root;

	while (true) {
		try {
			const stats = await stat(current);
			if (stats.isDirectory()) {
				return current;
			}
		} catch {
			// Keep walking up.
		}

		if (current === root) {
			break;
		}
		current = path.dirname(current);
	}

	return null;
}

function formatScopeLabel(searchRoot: string, cwd: string): string {
	const relative = path.relative(cwd, searchRoot).replace(/\\/g, "/");
	if (relative === "" || relative === ".") {
		return ".";
	}
	if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
		return relative;
	}
	return searchRoot;
}

function buildDisplayPath(searchRoot: string, cwd: string, relativePath: string): string {
	const scopeLabel = formatScopeLabel(searchRoot, cwd);
	const normalized = relativePath.replace(/\\/g, "/");
	if (scopeLabel === ".") {
		return normalized;
	}
	if (scopeLabel.startsWith("..") || path.isAbsolute(scopeLabel)) {
		return path.join(searchRoot, normalized).replace(/\\/g, "/");
	}
	return `${scopeLabel}/${normalized}`;
}

function levenshteinDistance(a: string, b: string): number {
	if (a === b) return 0;
	const aLen = a.length;
	const bLen = b.length;
	if (aLen === 0) return bLen;
	if (bLen === 0) return aLen;

	let prev = new Array<number>(bLen + 1);
	let curr = new Array<number>(bLen + 1);
	for (let j = 0; j <= bLen; j++) {
		prev[j] = j;
	}

	for (let i = 1; i <= aLen; i++) {
		curr[0] = i;
		const aCode = a.charCodeAt(i - 1);
		for (let j = 1; j <= bLen; j++) {
			const cost = aCode === b.charCodeAt(j - 1) ? 0 : 1;
			const deletion = prev[j] + 1;
			const insertion = curr[j - 1] + 1;
			const substitution = prev[j - 1] + cost;
			curr[j] = Math.min(deletion, insertion, substitution);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}

	return prev[bLen];
}

function similarityScore(a: string, b: string): number {
	if (a.length === 0 && b.length === 0) {
		return 1;
	}
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) {
		return 1;
	}
	const distance = levenshteinDistance(a, b);
	return 1 - distance / maxLen;
}

async function listCandidateFiles(
	searchRoot: string,
): Promise<{ files: string[]; truncated: boolean; error?: string }> {
	let fdPath: string | undefined;
	try {
		fdPath = await ensureTool("fd", true);
	} catch {
		return { files: [], truncated: false, error: "fd not available" };
	}

	if (!fdPath) {
		return { files: [], truncated: false, error: "fd not available" };
	}

	const args: string[] = ["--type", "f", "--color=never", "--hidden", "--max-results", String(MAX_FUZZY_CANDIDATES)];

	const gitignoreFiles = new Set<string>();
	const rootGitignore = path.join(searchRoot, ".gitignore");
	if (existsSync(rootGitignore)) {
		gitignoreFiles.add(rootGitignore);
	}

	try {
		const nestedGitignores = globSync("**/.gitignore", {
			cwd: searchRoot,
			dot: true,
			absolute: true,
			ignore: ["**/node_modules/**", "**/.git/**"],
		});
		for (const file of nestedGitignores) {
			gitignoreFiles.add(file);
		}
	} catch {
		// Ignore glob errors.
	}

	for (const gitignorePath of gitignoreFiles) {
		args.push("--ignore-file", gitignorePath);
	}

	args.push(".", searchRoot);

	const result = Bun.spawnSync([fdPath, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	const output = result.stdout.toString().trim();

	if (result.exitCode !== 0 && !output) {
		const errorMsg = result.stderr.toString().trim() || `fd exited with code ${result.exitCode}`;
		return { files: [], truncated: false, error: errorMsg };
	}

	if (!output) {
		return { files: [], truncated: false };
	}

	const files = output
		.split("\n")
		.map((line) => line.replace(/\r$/, "").trim())
		.filter((line) => line.length > 0);

	return { files, truncated: files.length >= MAX_FUZZY_CANDIDATES };
}

async function findReadPathSuggestions(
	rawPath: string,
	cwd: string,
): Promise<{ suggestions: string[]; scopeLabel?: string; truncated?: boolean; error?: string } | null> {
	const resolvedPath = resolveToCwd(rawPath, cwd);
	const searchRoot = await findExistingDirectory(path.dirname(resolvedPath));
	if (!searchRoot) {
		return null;
	}

	if (!isPathWithin(cwd, resolvedPath)) {
		const root = path.parse(searchRoot).root;
		if (searchRoot === root) {
			return null;
		}
	}

	const { files, truncated, error } = await listCandidateFiles(searchRoot);
	const scopeLabel = formatScopeLabel(searchRoot, cwd);

	if (error && files.length === 0) {
		return { suggestions: [], scopeLabel, truncated, error };
	}

	if (files.length === 0) {
		return null;
	}

	const queryPath = (() => {
		if (path.isAbsolute(rawPath)) {
			const relative = path.relative(cwd, resolvedPath).replace(/\\/g, "/");
			if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
				return normalizePathForMatch(relative);
			}
		}
		return normalizePathForMatch(rawPath);
	})();
	const baseQuery = path.posix.basename(queryPath);

	const matches: Array<{ path: string; score: number; baseScore: number; fullScore: number }> = [];
	const seen = new Set<string>();

	for (const file of files) {
		const cleaned = file.replace(/\r$/, "").trim();
		if (!cleaned) continue;

		const relativePath = path.isAbsolute(cleaned)
			? cleaned.startsWith(searchRoot)
				? cleaned.slice(searchRoot.length + 1)
				: path.relative(searchRoot, cleaned)
			: cleaned;

		if (!relativePath || relativePath.startsWith("..")) {
			continue;
		}

		const displayPath = buildDisplayPath(searchRoot, cwd, relativePath);
		if (seen.has(displayPath)) {
			continue;
		}
		seen.add(displayPath);

		const normalizedDisplay = normalizePathForMatch(displayPath);
		const baseCandidate = path.posix.basename(normalizedDisplay);

		const fullScore = similarityScore(queryPath, normalizedDisplay);
		const baseScore = baseQuery ? similarityScore(baseQuery, baseCandidate) : 0;

		if (baseQuery) {
			if (baseScore < MIN_BASE_SIMILARITY && fullScore < MIN_FULL_SIMILARITY) {
				continue;
			}
		} else if (fullScore < MIN_FULL_SIMILARITY) {
			continue;
		}

		const score = baseQuery ? baseScore * 0.75 + fullScore * 0.25 : fullScore;
		matches.push({ path: displayPath, score, baseScore, fullScore });
	}

	if (matches.length === 0) {
		return { suggestions: [], scopeLabel, truncated };
	}

	matches.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		if (b.baseScore !== a.baseScore) return b.baseScore - a.baseScore;
		return a.path.localeCompare(b.path);
	});

	const suggestions = matches.slice(0, MAX_FUZZY_RESULTS).map((match) => match.path);

	return { suggestions, scopeLabel, truncated };
}

function convertWithMarkitdown(filePath: string): { content: string; ok: boolean; error?: string } {
	const cmd = Bun.which("markitdown");
	if (!cmd) {
		return { content: "", ok: false, error: "markitdown not found" };
	}

	const result = spawnSync(cmd, [filePath], {
		encoding: "utf-8",
		timeout: 60000,
		maxBuffer: 50 * 1024 * 1024,
	});

	if (result.status === 0 && result.stdout && result.stdout.length > 0) {
		return { content: result.stdout, ok: true };
	}

	return { content: "", ok: false, error: result.stderr || "Conversion failed" };
}

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export interface ReadToolDetails {
	truncation?: TruncationResult;
	redirectedTo?: "ls";
}

export function createReadTool(cwd: string): AgentTool<typeof readSchema> {
	const lsTool = createLsTool(cwd);
	return {
		name: "read",
		label: "Read",
		description: readDescription.replace("{{DEFAULT_MAX_LINES}}", String(DEFAULT_MAX_LINES)),
		parameters: readSchema,
		execute: async (
			toolCallId: string,
			{ path: readPath, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
		) => {
			const absolutePath = resolveReadPath(readPath, cwd);

			return untilAborted(signal, async () => {
				let fileStat: Awaited<ReturnType<typeof stat>>;
				try {
					fileStat = await stat(absolutePath);
				} catch (error) {
					if (isNotFoundError(error)) {
						const suggestions = await findReadPathSuggestions(readPath, cwd);
						let message = `File not found: ${readPath}`;

						if (suggestions?.suggestions.length) {
							const scopeLabel = suggestions.scopeLabel ? ` in ${suggestions.scopeLabel}` : "";
							message += `\n\nClosest matches${scopeLabel}:\n${suggestions.suggestions
								.map((match) => `- ${match}`)
								.join("\n")}`;
							if (suggestions.truncated) {
								message += `\n[Search truncated to first ${MAX_FUZZY_CANDIDATES} paths. Refine the path if the match isn't listed.]`;
							}
						} else if (suggestions?.error) {
							message += `\n\nFuzzy match failed: ${suggestions.error}`;
						} else if (suggestions?.scopeLabel) {
							message += `\n\nNo similar paths found in ${suggestions.scopeLabel}.`;
						}

						throw new Error(message);
					}
					throw error;
				}

				if (fileStat.isDirectory()) {
					const lsResult = await lsTool.execute(toolCallId, { path: readPath, limit }, signal);
					return {
						content: lsResult.content,
						details: { redirectedTo: "ls", truncation: lsResult.details?.truncation },
					};
				}

				await access(absolutePath, constants.R_OK);

				const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
				const ext = path.extname(absolutePath).toLowerCase();

				// Read the file based on type
				let content: (TextContent | ImageContent)[];
				let details: ReadToolDetails | undefined;

				if (mimeType) {
					// Check image file size before reading to prevent OOM during serialization
					const fileStat = await stat(absolutePath);
					if (fileStat.size > MAX_IMAGE_SIZE) {
						const sizeStr = formatSize(fileStat.size);
						const maxStr = formatSize(MAX_IMAGE_SIZE);
						content = [
							{
								type: "text",
								text: `[Image file too large: ${sizeStr} exceeds ${maxStr} limit. Use an image viewer or resize the image.]`,
							},
						];
					} else {
						// Read as image (binary)
						const buffer = await readFile(absolutePath);
						const base64 = buffer.toString("base64");

						content = [
							{ type: "text", text: `Read image file [${mimeType}]` },
							{ type: "image", data: base64, mimeType },
						];
					}
				} else if (CONVERTIBLE_EXTENSIONS.has(ext)) {
					// Convert document via markitdown
					const result = convertWithMarkitdown(absolutePath);
					if (result.ok) {
						// Apply truncation to converted content
						const truncation = truncateHead(result.content);
						let outputText = truncation.content;

						if (truncation.truncated) {
							outputText += `\n\n[Document converted via markitdown. Output truncated to $formatSize(
								DEFAULT_MAX_BYTES,
							)]`;
							details = { truncation };
						}

						content = [{ type: "text", text: outputText }];
					} else {
						// markitdown not available or failed
						const errorMsg =
							result.error === "markitdown not found"
								? `markitdown not installed. Install with: pip install markitdown`
								: result.error || "conversion failed";
						content = [{ type: "text", text: `[Cannot read ${ext} file: ${errorMsg}]` }];
					}
				} else {
					// Read as text
					const textContent = await readFile(absolutePath, "utf-8");
					const allLines = textContent.split("\n");
					const totalFileLines = allLines.length;

					// Apply offset if specified (1-indexed to 0-indexed)
					const startLine = offset ? Math.max(0, offset - 1) : 0;
					const startLineDisplay = startLine + 1; // For display (1-indexed)

					// Check if offset is out of bounds
					if (startLine >= allLines.length) {
						throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
					}

					// If limit is specified by user, use it; otherwise we'll let truncateHead decide
					let selectedContent: string;
					let userLimitedLines: number | undefined;
					if (limit !== undefined) {
						const endLine = Math.min(startLine + limit, allLines.length);
						selectedContent = allLines.slice(startLine, endLine).join("\n");
						userLimitedLines = endLine - startLine;
					} else {
						selectedContent = allLines.slice(startLine).join("\n");
					}

					// Apply truncation (respects both line and byte limits)
					const truncation = truncateHead(selectedContent);

					let outputText: string;

					if (truncation.firstLineExceedsLimit) {
						// First line at offset exceeds 30KB - tell model to use bash
						const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
						outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(
							DEFAULT_MAX_BYTES,
						)} limit. Use bash: sed -n '${startLineDisplay}p' ${readPath} | head -c ${DEFAULT_MAX_BYTES}]`;
						details = { truncation };
					} else if (truncation.truncated) {
						// Truncation occurred - build actionable notice
						const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
						const nextOffset = endLineDisplay + 1;

						outputText = truncation.content;

						if (truncation.truncatedBy === "lines") {
							outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
						} else {
							outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(
								DEFAULT_MAX_BYTES,
							)} limit). Use offset=${nextOffset} to continue]`;
						}
						details = { truncation };
					} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
						// User specified limit, there's more content, but no truncation
						const remaining = allLines.length - (startLine + userLimitedLines);
						const nextOffset = startLine + userLimitedLines + 1;

						outputText = truncation.content;
						outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue]`;
					} else {
						// No truncation, no user limit exceeded
						outputText = truncation.content;
					}

					content = [{ type: "text", text: outputText }];
				}

				return { content, details };
			});
		},
	};
}

/** Default read tool using process.cwd() - for backwards compatibility */
export const readTool = createReadTool(process.cwd());
