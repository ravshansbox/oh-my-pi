/**
 * Ask Tool - Interactive user prompting during execution
 *
 * Use this tool when you need to ask the user questions during execution.
 * This allows you to:
 *   1. Gather user preferences or requirements
 *   2. Clarify ambiguous instructions
 *   3. Get decisions on implementation choices as you work
 *   4. Offer choices to the user about what direction to take
 *
 * Usage notes:
 *   - Users will always be able to select "Other" to provide custom text input
 *   - Use multi: true to allow multiple answers to be selected for a question
 *   - If you recommend a specific option, make that the first option in the list
 *     and add "(Recommended)" at the end of the label
 */

import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { Type } from "@sinclair/typebox";
import { type Theme, theme } from "../../modes/interactive/theme/theme";
import askDescription from "../../prompts/tools/ask.md" with { type: "text" };
import type { RenderResultOptions } from "../custom-tools/types";
import { renderPromptTemplate } from "../prompt-templates";
import type { ToolSession } from "./index";
import { createToolUIKit } from "./render-utils";

// =============================================================================
// Types
// =============================================================================

const OptionItem = Type.Object({
	label: Type.String({ description: "Display label for this option" }),
});

const askSchema = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionItem, {
		description: "Available options for the user to choose from.",
		minItems: 1,
	}),
	multi: Type.Optional(
		Type.Boolean({
			description: "Allow multiple options to be selected (default: false)",
			default: false,
		}),
	),
});

export interface AskToolDetails {
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
}

// =============================================================================
// Constants
// =============================================================================

const OTHER_OPTION = "Other (type your own)";
function getDoneOptionLabel(): string {
	return `${theme.status.success} Done selecting`;
}

// =============================================================================
// Tool Implementation
// =============================================================================

export function createAskTool(session: ToolSession): null | AgentTool<typeof askSchema, AskToolDetails> {
	if (!session.hasUI) {
		return null;
	}
	return {
		name: "ask",
		label: "Ask",
		description: renderPromptTemplate(askDescription),
		parameters: askSchema,

		async execute(
			_toolCallId: string,
			params: { question: string; options: Array<{ label: string }>; multi?: boolean },
			_signal?: AbortSignal,
			_onUpdate?: AgentToolUpdateCallback<AskToolDetails>,
			context?: AgentToolContext,
		) {
			const { question, options, multi = false } = params;
			const optionLabels = options.map((o) => o.label);
			const doneLabel = getDoneOptionLabel();

			// Headless fallback - return error if no UI available
			if (!context?.hasUI || !context.ui) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Error: User prompt requires interactive mode",
						},
					],
					details: {
						question,
						options: optionLabels,
						multi,
						selectedOptions: [],
					},
				};
			}

			const { ui } = context;
			let selectedOptions: string[] = [];
			let customInput: string | undefined;

			if (multi) {
				// Multi-select: show checkboxes in the label to indicate selection state
				const selected = new Set<string>();

				while (true) {
					// Build options with checkbox indicators
					const opts: string[] = [];

					// Add "Done" option if any selected
					if (selected.size > 0) {
						opts.push(doneLabel);
					}

					// Add all options with checkbox prefix
					for (const opt of optionLabels) {
						const checkbox = selected.has(opt) ? theme.checkbox.checked : theme.checkbox.unchecked;
						opts.push(`${checkbox} ${opt}`);
					}

					// Add "Other" option
					opts.push(OTHER_OPTION);

					const prefix = selected.size > 0 ? `(${selected.size} selected) ` : "";
					const choice = await ui.select(`${prefix}${question}`, opts);

					if (choice === undefined || choice === doneLabel) break;

					if (choice === OTHER_OPTION) {
						const input = await ui.input("Enter your response:");
						if (input) customInput = input;
						break;
					}

					// Toggle selection - extract the actual option name
					const checkedPrefix = `${theme.checkbox.checked} `;
					const uncheckedPrefix = `${theme.checkbox.unchecked} `;
					let opt: string | undefined;
					if (choice.startsWith(checkedPrefix)) {
						opt = choice.slice(checkedPrefix.length);
					} else if (choice.startsWith(uncheckedPrefix)) {
						opt = choice.slice(uncheckedPrefix.length);
					}
					if (opt) {
						if (selected.has(opt)) {
							selected.delete(opt);
						} else {
							selected.add(opt);
						}
					}
				}
				selectedOptions = Array.from(selected);
			} else {
				// Single select with "Other" option
				const choice = await ui.select(question, [...optionLabels, OTHER_OPTION]);
				if (choice === OTHER_OPTION) {
					const input = await ui.input("Enter your response:");
					if (input) customInput = input;
				} else if (choice) {
					selectedOptions = [choice];
				}
			}

			const details: AskToolDetails = {
				question,
				options: optionLabels,
				multi,
				selectedOptions,
				customInput,
			};

			let responseText: string;
			if (customInput) {
				responseText = `User provided custom input: ${customInput}`;
			} else if (selectedOptions.length > 0) {
				responseText = multi
					? `User selected: ${selectedOptions.join(", ")}`
					: `User selected: ${selectedOptions[0]}`;
			} else {
				responseText = "User cancelled the selection";
			}

			return { content: [{ type: "text" as const, text: responseText }], details };
		},
	};
}

/** Default ask tool - returns null when no UI */
export const askTool = createAskTool({
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
});

// =============================================================================
// TUI Renderer
// =============================================================================

interface AskRenderArgs {
	question: string;
	options?: Array<{ label: string }>;
	multi?: boolean;
}

export const askToolRenderer = {
	renderCall(args: AskRenderArgs, uiTheme: Theme): Component {
		const ui = createToolUIKit(uiTheme);
		if (!args.question) {
			return new Text(ui.errorMessage("No question provided"), 0, 0);
		}

		const label = ui.title("Ask");
		let text = `${label} ${uiTheme.fg("accent", args.question)}`;

		const meta: string[] = [];
		if (args.multi) meta.push("multi");
		if (args.options?.length) meta.push(`options:${args.options.length}`);
		text += ui.meta(meta);

		if (args.options?.length) {
			for (let i = 0; i < args.options.length; i++) {
				const opt = args.options[i];
				const isLast = i === args.options.length - 1;
				const branch = isLast ? uiTheme.tree.last : uiTheme.tree.branch;
				text += `\n ${uiTheme.fg("dim", branch)} ${uiTheme.fg("dim", uiTheme.checkbox.unchecked)} ${uiTheme.fg("muted", opt.label)}`;
			}
		}

		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AskToolDetails },
		_opts: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const { details } = result;
		if (!details) {
			const txt = result.content[0];
			return new Text(txt?.type === "text" && txt.text ? txt.text : "", 0, 0);
		}

		const hasSelection = details.customInput || details.selectedOptions.length > 0;
		const statusIcon = hasSelection
			? uiTheme.styledSymbol("status.success", "success")
			: uiTheme.styledSymbol("status.warning", "warning");

		let text = `${statusIcon} ${uiTheme.fg("accent", details.question)}`;

		if (details.customInput) {
			text += `\n ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.styledSymbol(
				"status.success",
				"success",
			)} ${uiTheme.fg("toolOutput", details.customInput)}`;
		} else if (details.selectedOptions.length > 0) {
			const selected = details.selectedOptions;
			for (let i = 0; i < selected.length; i++) {
				const isLast = i === selected.length - 1;
				const branch = isLast ? uiTheme.tree.last : uiTheme.tree.branch;
				text += `\n ${uiTheme.fg("dim", branch)} ${uiTheme.fg(
					"success",
					uiTheme.checkbox.checked,
				)} ${uiTheme.fg("toolOutput", selected[i])}`;
			}
		} else {
			text += `\n ${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.styledSymbol(
				"status.warning",
				"warning",
			)} ${uiTheme.fg("warning", "Cancelled")}`;
		}

		return new Text(text, 0, 0);
	},
};
