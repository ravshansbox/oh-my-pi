/**
 * TUI rendering for task tool.
 *
 * Provides renderCall and renderResult functions for displaying
 * task execution in the terminal UI.
 */

import path from "node:path";
import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Text } from "@oh-my-pi/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme";
import type { RenderResultOptions } from "../../custom-tools/types";
import {
	formatBadge,
	formatDuration,
	formatMoreItems,
	formatTokens,
	getStyledStatusIcon,
	truncate,
} from "../render-utils";
import type { ReportFindingDetails, SubmitReviewDetails } from "../review";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import type { AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "./types";

/** Priority labels for review findings */
const PRIORITY_LABELS: Record<number, string> = {
	0: "P0",
	1: "P1",
	2: "P2",
	3: "P3",
};

/**
 * Get status icon for agent state.
 * For running status, uses animated spinner if spinnerFrame is provided.
 * Maps AgentProgress status to styled icon format.
 */
function getStatusIcon(status: AgentProgress["status"], theme: Theme, spinnerFrame?: number): string {
	switch (status) {
		case "pending":
			return getStyledStatusIcon("pending", theme);
		case "running":
			return getStyledStatusIcon("running", theme, spinnerFrame);
		case "completed":
			return getStyledStatusIcon("success", theme);
		case "failed":
			return getStyledStatusIcon("error", theme);
		case "aborted":
			return getStyledStatusIcon("aborted", theme);
	}
}

function formatFindingSummary(findings: ReportFindingDetails[], theme: Theme): string {
	if (findings.length === 0) return theme.fg("dim", "Findings: none");

	const counts = new Map<number, number>();
	for (const finding of findings) {
		counts.set(finding.priority, (counts.get(finding.priority) ?? 0) + 1);
	}

	const parts: string[] = [];
	for (const priority of [0, 1, 2, 3]) {
		const label = PRIORITY_LABELS[priority] ?? "P?";
		const color = priority === 0 ? "error" : priority === 1 ? "warning" : "muted";
		const count = counts.get(priority) ?? 0;
		parts.push(theme.fg(color, `${label}:${count}`));
	}

	return `${theme.fg("dim", "Findings:")} ${parts.join(theme.sep.dot)}`;
}

function renderOutputSection(
	output: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	maxCollapsed = 3,
	maxExpanded = 10,
): string[] {
	const lines: string[] = [];
	const outputLines = output.split("\n").filter((line) => line.trim());
	if (outputLines.length === 0) return lines;

	lines.push(`${continuePrefix}${theme.fg("dim", "Output")}`);

	const previewCount = expanded ? maxExpanded : maxCollapsed;
	for (const line of outputLines.slice(0, previewCount)) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", truncate(line, 70, theme.format.ellipsis))}`);
	}

	if (outputLines.length > previewCount) {
		lines.push(
			`${continuePrefix}  ${theme.fg("dim", formatMoreItems(outputLines.length - previewCount, "line", theme))}`,
		);
	}

	return lines;
}

/**
 * Render the tool call arguments.
 */
export function renderCall(args: TaskParams, theme: Theme): Component {
	const label = theme.fg("toolTitle", theme.bold("Task"));

	if (args.tasks.length === 1) {
		// Single task - show agent and task preview
		const task = args.tasks[0];
		const summary = task.description?.trim() || task.task;
		const taskPreview = truncate(summary, 60, theme.format.ellipsis);
		return new Text(`${label} ${theme.fg("accent", task.agent)}: ${theme.fg("muted", taskPreview)}`, 0, 0);
	}

	// Multiple tasks - show count and descriptions (or agent names as fallback)
	const agents = args.tasks.map((t) => t.description?.trim() || t.agent).join(", ");
	return new Text(
		`${label} ${theme.fg("muted", `${args.tasks.length} agents: ${truncate(agents, 50, theme.format.ellipsis)}`)}`,
		0,
		0,
	);
}

/**
 * Render streaming progress for a single agent.
 */
function renderAgentProgress(
	progress: AgentProgress,
	isLast: boolean,
	expanded: boolean,
	theme: Theme,
	spinnerFrame?: number,
): string[] {
	const lines: string[] = [];
	const prefix = isLast
		? `${theme.boxSharp.bottomLeft}${theme.boxSharp.horizontal}`
		: `${theme.boxSharp.teeRight}${theme.boxSharp.horizontal}`;
	const continuePrefix = isLast ? "   " : `${theme.boxSharp.vertical}  `;

	const icon = getStatusIcon(progress.status, theme, spinnerFrame);
	const iconColor =
		progress.status === "completed"
			? "success"
			: progress.status === "failed" || progress.status === "aborted"
				? "error"
				: "accent";

	// Main status line - include index for Output tool ID derivation
	const agentId = `${progress.agent}(${progress.index})`;
	let statusLine = `${prefix} ${theme.fg(iconColor, icon)} ${theme.fg("accent", agentId)}`;
	const description = progress.description?.trim();
	if (description) {
		statusLine += ` ${theme.fg("muted", truncate(description, 40, theme.format.ellipsis))}`;
	}

	// Only show badge for non-running states (spinner already indicates running)
	if (progress.status !== "running") {
		const statusLabel =
			progress.status === "completed"
				? "done"
				: progress.status === "failed"
					? "failed"
					: progress.status === "aborted"
						? "aborted"
						: "pending";
		statusLine += ` ${formatBadge(statusLabel, iconColor, theme)}`;
	}

	if (progress.status === "running") {
		if (!description) {
			const taskPreview = truncate(progress.task, 40, theme.format.ellipsis);
			statusLine += ` ${theme.fg("muted", taskPreview)}`;
		}
		statusLine += `${theme.sep.dot}${theme.fg("dim", `${progress.toolCount} tools`)}`;
		if (progress.tokens > 0) {
			statusLine += `${theme.sep.dot}${theme.fg("dim", `${formatTokens(progress.tokens)} tokens`)}`;
		}
	} else if (progress.status === "completed") {
		statusLine += `${theme.sep.dot}${theme.fg("dim", `${progress.toolCount} tools`)}`;
		statusLine += `${theme.sep.dot}${theme.fg("dim", `${formatTokens(progress.tokens)} tokens`)}`;
	}

	lines.push(statusLine);

	// Current tool (if running)
	if (progress.status === "running" && progress.currentTool) {
		let toolLine = `${continuePrefix}${theme.tree.hook} ${theme.fg("muted", progress.currentTool)}`;
		if (progress.currentToolArgs) {
			toolLine += `: ${theme.fg("dim", truncate(progress.currentToolArgs, 40, theme.format.ellipsis))}`;
		}
		if (progress.currentToolStartMs) {
			const elapsed = Date.now() - progress.currentToolStartMs;
			if (elapsed > 5000) {
				toolLine += `${theme.sep.dot}${theme.fg("warning", formatDuration(elapsed))}`;
			}
		}
		lines.push(toolLine);
	}

	// Render extracted tool data inline (e.g., review findings)
	if (progress.extractedToolData) {
		for (const [toolName, dataArray] of Object.entries(progress.extractedToolData)) {
			const handler = subprocessToolRegistry.getHandler(toolName);
			if (handler?.renderInline) {
				// Show last few items inline
				const recentData = (dataArray as unknown[]).slice(-3);
				for (const data of recentData) {
					const component = handler.renderInline(data, theme);
					if (component instanceof Text) {
						lines.push(`${continuePrefix}${component.getText()}`);
					}
				}
				if (dataArray.length > 3) {
					lines.push(`${continuePrefix}${theme.fg("dim", formatMoreItems(dataArray.length - 3, "item", theme))}`);
				}
			}
		}
	}

	// Expanded view: recent output and tools
	if (expanded && progress.status === "running") {
		const output = progress.recentOutput.join("\n");
		lines.push(...renderOutputSection(output, continuePrefix, true, theme, 2, 6));
	}

	return lines;
}

/**
 * Render review result with combined verdict + findings in tree structure.
 */
function renderReviewResult(
	summary: SubmitReviewDetails,
	findings: ReportFindingDetails[],
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
): string[] {
	const lines: string[] = [];

	// Verdict line
	const verdictColor = summary.overall_correctness === "correct" ? "success" : "error";
	const verdictIcon = summary.overall_correctness === "correct" ? theme.status.success : theme.status.error;
	lines.push(
		`${continuePrefix}${theme.fg(verdictColor, verdictIcon)} Patch is ${theme.fg(verdictColor, summary.overall_correctness)} ${theme.fg("dim", `(${(summary.confidence * 100).toFixed(0)}% confidence)`)}`,
	);

	// Explanation preview (first ~80 chars when collapsed, full when expanded)
	if (summary.explanation) {
		if (expanded) {
			lines.push(`${continuePrefix}${theme.fg("dim", "Summary")}`);
			const explanationLines = summary.explanation.split("\n");
			for (const line of explanationLines) {
				lines.push(`${continuePrefix}  ${theme.fg("dim", line)}`);
			}
		} else {
			// Preview: first sentence or ~100 chars
			const preview = truncate(`${summary.explanation.split(/[.!?]/)[0]}.`, 100, theme.format.ellipsis);
			lines.push(`${continuePrefix}${theme.fg("dim", `Summary: ${preview}`)}`);
		}
	}

	// Findings summary + list
	lines.push(`${continuePrefix}${formatFindingSummary(findings, theme)}`);

	if (findings.length > 0) {
		lines.push(`${continuePrefix}`); // Spacing
		lines.push(...renderFindings(findings, continuePrefix, expanded, theme));
	}

	return lines;
}

/**
 * Render review findings list (used with and without submit_review).
 */
function renderFindings(
	findings: ReportFindingDetails[],
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
): string[] {
	const lines: string[] = [];
	const displayCount = expanded ? findings.length : Math.min(3, findings.length);

	for (let i = 0; i < displayCount; i++) {
		const finding = findings[i];
		const isLastFinding = i === displayCount - 1 && (expanded || findings.length <= 3);
		const findingPrefix = isLastFinding
			? `${theme.boxSharp.bottomLeft}${theme.boxSharp.horizontal}`
			: `${theme.boxSharp.teeRight}${theme.boxSharp.horizontal}`;
		const findingContinue = isLastFinding ? "   " : `${theme.boxSharp.vertical}  `;

		const priority = PRIORITY_LABELS[finding.priority] ?? "P?";
		const color = finding.priority === 0 ? "error" : finding.priority === 1 ? "warning" : "muted";
		const titleText = finding.title.replace(/^\[P\d\]\s*/, "");
		const loc = `${path.basename(finding.file_path)}:${finding.line_start}`;

		lines.push(
			`${continuePrefix}${findingPrefix} ${theme.fg(color, `[${priority}]`)} ${titleText} ${theme.fg("dim", loc)}`,
		);

		// Show body when expanded
		if (expanded && finding.body) {
			// Wrap body text
			const bodyLines = finding.body.split("\n");
			for (const bodyLine of bodyLines) {
				lines.push(`${continuePrefix}${findingContinue}${theme.fg("dim", bodyLine)}`);
			}
		}
	}

	if (!expanded && findings.length > 3) {
		lines.push(`${continuePrefix}${theme.fg("dim", formatMoreItems(findings.length - 3, "finding", theme))}`);
	}

	return lines;
}

/**
 * Render final result for a single agent.
 */
function renderAgentResult(result: SingleResult, isLast: boolean, expanded: boolean, theme: Theme): string[] {
	const lines: string[] = [];
	const prefix = isLast
		? `${theme.boxSharp.bottomLeft}${theme.boxSharp.horizontal}`
		: `${theme.boxSharp.teeRight}${theme.boxSharp.horizontal}`;
	const continuePrefix = isLast ? "   " : `${theme.boxSharp.vertical}  `;

	const aborted = result.aborted ?? false;
	const success = !aborted && result.exitCode === 0;
	const icon = aborted ? theme.status.aborted : success ? theme.status.success : theme.status.error;
	const iconColor = success ? "success" : "error";
	const statusText = aborted ? "aborted" : success ? "done" : "failed";

	// Main status line - include index for Output tool ID derivation
	const agentId = `${result.agent}(${result.index})`;
	let statusLine = `${prefix} ${theme.fg(iconColor, icon)} ${theme.fg("accent", agentId)} ${formatBadge(statusText, iconColor, theme)}`;
	const description = result.description?.trim();
	if (description) {
		statusLine += ` ${theme.fg("muted", truncate(description, 40, theme.format.ellipsis))}`;
	}
	if (result.tokens > 0) {
		statusLine += `${theme.sep.dot}${theme.fg("dim", `${formatTokens(result.tokens)} tokens`)}`;
	}
	statusLine += `${theme.sep.dot}${theme.fg("dim", formatDuration(result.durationMs))}`;

	if (result.truncated) {
		statusLine += ` ${theme.fg("warning", "[truncated]")}`;
	}

	lines.push(statusLine);

	// Check for review result (submit_review + report_finding)
	const submitReviewData = result.extractedToolData?.submit_review as SubmitReviewDetails[] | undefined;
	const reportFindingData = result.extractedToolData?.report_finding as ReportFindingDetails[] | undefined;

	if (submitReviewData && submitReviewData.length > 0) {
		// Use combined review renderer
		const summary = submitReviewData[submitReviewData.length - 1];
		const findings = reportFindingData ?? [];
		lines.push(...renderReviewResult(summary, findings, continuePrefix, expanded, theme));
		return lines;
	}
	if (reportFindingData && reportFindingData.length > 0) {
		lines.push(
			`${continuePrefix}${theme.fg("warning", theme.status.warning)} ${theme.fg("dim", "Review summary missing (submit_review not called)")}`,
		);
		lines.push(`${continuePrefix}${formatFindingSummary(reportFindingData, theme)}`);
		lines.push(`${continuePrefix}`); // Spacing
		lines.push(...renderFindings(reportFindingData, continuePrefix, expanded, theme));
		return lines;
	}

	// Check for extracted tool data with custom renderers (skip review tools)
	let hasCustomRendering = false;
	if (result.extractedToolData) {
		for (const [toolName, dataArray] of Object.entries(result.extractedToolData)) {
			// Skip review tools - handled above
			if (toolName === "submit_review" || toolName === "report_finding") continue;

			const handler = subprocessToolRegistry.getHandler(toolName);
			if (handler?.renderFinal && (dataArray as unknown[]).length > 0) {
				hasCustomRendering = true;
				const component = handler.renderFinal(dataArray as unknown[], theme, expanded);
				if (component instanceof Text) {
					// Prefix each line with continuePrefix
					const text = component.getText();
					for (const line of text.split("\n")) {
						if (line.trim()) {
							lines.push(`${continuePrefix}${line}`);
						}
					}
				} else if (component instanceof Container) {
					// For containers, render each child
					for (const child of (component as Container).children) {
						if (child instanceof Text) {
							lines.push(`${continuePrefix}${child.getText()}`);
						}
					}
				}
			}
		}
	}

	// Fallback to output preview if no custom rendering
	if (!hasCustomRendering) {
		lines.push(...renderOutputSection(result.output, continuePrefix, expanded, theme, 3, 12));
	}

	// Error message
	if (result.error && !success) {
		lines.push(`${continuePrefix}${theme.fg("error", truncate(result.error, 70, theme.format.ellipsis))}`);
	}

	return lines;
}

/**
 * Render the tool result.
 */
export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: TaskToolDetails },
	options: RenderResultOptions,
	theme: Theme,
): Component {
	const { expanded, isPartial, spinnerFrame } = options;
	const details = result.details;

	if (!details) {
		// Fallback to simple text
		const text = result.content.find((c) => c.type === "text")?.text || "";
		return new Text(theme.fg("dim", truncate(text, 100, theme.format.ellipsis)), 0, 0);
	}

	const lines: string[] = [];

	if (isPartial && details.progress) {
		// Streaming progress view
		details.progress.forEach((progress, i) => {
			const isLast = i === details.progress!.length - 1;
			lines.push(...renderAgentProgress(progress, isLast, expanded, theme, spinnerFrame));
		});
	} else if (details.results.length > 0) {
		// Final results view
		details.results.forEach((res, i) => {
			const isLast = i === details.results.length - 1;
			lines.push(...renderAgentResult(res, isLast, expanded, theme));
		});

		// Summary line
		const abortedCount = details.results.filter((r) => r.aborted).length;
		const successCount = details.results.filter((r) => !r.aborted && r.exitCode === 0).length;
		const failCount = details.results.length - successCount - abortedCount;
		let summary = `\n${theme.fg("dim", "Total:")} `;
		if (abortedCount > 0) {
			summary += theme.fg("error", `${abortedCount} aborted`);
			if (successCount > 0 || failCount > 0) summary += theme.sep.dot;
		}
		if (successCount > 0) {
			summary += theme.fg("success", `${successCount} succeeded`);
			if (failCount > 0) summary += theme.sep.dot;
		}
		if (failCount > 0) {
			summary += theme.fg("error", `${failCount} failed`);
		}
		summary += `${theme.sep.dot}${theme.fg("dim", formatDuration(details.totalDurationMs))}`;
		lines.push(summary);

		// Artifacts suppressed from user view - available via session file
	}

	if (lines.length === 0) {
		return new Text(theme.fg("dim", "No results"), 0, 0);
	}

	return new Text(lines.join("\n"), 0, 0);
}

export const taskToolRenderer = {
	renderCall,
	renderResult,
};
