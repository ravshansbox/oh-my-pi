/**
 * Bundled agent definitions.
 *
 * Agents are embedded at build time via Bun's import with { type: "text" }.
 */

import exploreMd from "../../../prompts/agents/explore.md" with { type: "text" };
// Embed agent markdown files at build time
import agentFrontmatterTemplate from "../../../prompts/agents/frontmatter.md" with { type: "text" };
import planMd from "../../../prompts/agents/plan.md" with { type: "text" };
import reviewerMd from "../../../prompts/agents/reviewer.md" with { type: "text" };
import taskMd from "../../../prompts/agents/task.md" with { type: "text" };
import { renderPromptTemplate } from "../../prompt-templates";
import type { AgentDefinition, AgentSource } from "./types";

interface AgentFrontmatter {
	name: string;
	description: string;
	spawns?: string;
	model?: string;
}

interface EmbeddedAgentDef {
	fileName: string;
	frontmatter?: AgentFrontmatter;
	template: string;
}

function buildAgentContent(def: EmbeddedAgentDef): string {
	const body = renderPromptTemplate(def.template);
	if (!def.frontmatter) return body;
	return renderPromptTemplate(agentFrontmatterTemplate, { ...def.frontmatter, body });
}

const EMBEDDED_AGENT_DEFS: EmbeddedAgentDef[] = [
	{ fileName: "explore.md", template: exploreMd },
	{ fileName: "plan.md", template: planMd },
	{ fileName: "reviewer.md", template: reviewerMd },
	{
		fileName: "task.md",
		frontmatter: {
			name: "task",
			description: "General-purpose subagent with full capabilities for delegated multi-step tasks",
			spawns: "explore",
			model: "default",
		},
		template: taskMd,
	},
	{
		fileName: "quick_task.md",
		frontmatter: {
			name: "quick_task",
			description: "Quick task for fast execution",
			model: "pi/smol",
		},
		template: taskMd,
	},
	{
		fileName: "deep_task.md",
		frontmatter: {
			name: "deep_task",
			description: "Deep task for comprehensive reasoning",
			model: "pi/slow",
		},
		template: taskMd,
	},
];

const EMBEDDED_AGENTS: { name: string; content: string }[] = EMBEDDED_AGENT_DEFS.map((def) => ({
	name: def.fileName,
	content: buildAgentContent(def),
}));

/**
 * Parse YAML frontmatter from markdown content.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const frontmatter: Record<string, string> = {};
	const normalized = content.replace(/\r\n/g, "\n");

	if (!normalized.startsWith("---")) {
		return { frontmatter, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter, body: normalized };
	}

	const frontmatterBlock = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	for (const line of frontmatterBlock.split("\n")) {
		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (match) {
			let value = match[2].trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			frontmatter[match[1]] = value;
		}
	}

	return { frontmatter, body };
}

/**
 * Parse an agent from embedded content.
 */
function parseAgent(fileName: string, content: string, source: AgentSource): AgentDefinition | null {
	const { frontmatter, body } = parseFrontmatter(content);

	if (!frontmatter.name || !frontmatter.description) {
		return null;
	}

	const tools = frontmatter.tools
		?.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

	// Parse spawns field
	let spawns: string[] | "*" | undefined;
	if (frontmatter.spawns !== undefined) {
		const spawnsRaw = frontmatter.spawns.trim();
		if (spawnsRaw === "*") {
			spawns = "*";
		} else if (spawnsRaw) {
			spawns = spawnsRaw
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			if (spawns.length === 0) spawns = undefined;
		}
	}

	// Backward compat: infer spawns: "*" when tools includes "task"
	if (spawns === undefined && tools?.includes("task")) {
		spawns = "*";
	}

	return {
		name: frontmatter.name,
		description: frontmatter.description,
		tools: tools && tools.length > 0 ? tools : undefined,
		spawns,
		model: frontmatter.model,
		systemPrompt: body,
		source,
		filePath: `embedded:${fileName}`,
	};
}

/** Cache for bundled agents */
let bundledAgentsCache: AgentDefinition[] | null = null;

/**
 * Load all bundled agents from embedded content.
 * Results are cached after first load.
 */
export function loadBundledAgents(): AgentDefinition[] {
	if (bundledAgentsCache !== null) {
		return bundledAgentsCache;
	}

	const agents: AgentDefinition[] = [];

	for (const { name, content } of EMBEDDED_AGENTS) {
		const agent = parseAgent(name, content, "bundled");
		if (agent) {
			agents.push(agent);
		}
	}

	bundledAgentsCache = agents;
	return agents;
}

/**
 * Get a bundled agent by name.
 */
export function getBundledAgent(name: string): AgentDefinition | undefined {
	return loadBundledAgents().find((a) => a.name === name);
}

/**
 * Get all bundled agents as a map keyed by name.
 */
export function getBundledAgentsMap(): Map<string, AgentDefinition> {
	const map = new Map<string, AgentDefinition>();
	for (const agent of loadBundledAgents()) {
		map.set(agent.name, agent);
	}
	return map;
}

/**
 * Clear the bundled agents cache (for testing).
 */
export function clearBundledAgentsCache(): void {
	bundledAgentsCache = null;
}

// Re-export for backward compatibility
export const BUNDLED_AGENTS = loadBundledAgents;
