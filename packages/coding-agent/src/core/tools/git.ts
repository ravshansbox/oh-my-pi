import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type GitParams, gitTool as gitToolCore, type ToolResponse } from "@oh-my-pi/pi-git-tool";
import { type Static, Type } from "@sinclair/typebox";
import gitDescription from "../../prompts/tools/git.md" with { type: "text" };
import { renderPromptTemplate } from "../prompt-templates";
import type { ToolSession } from "./index";

const gitSchema = Type.Object({
	operation: Type.Union([
		Type.Literal("status"),
		Type.Literal("diff"),
		Type.Literal("log"),
		Type.Literal("show"),
		Type.Literal("blame"),
		Type.Literal("branch"),
		Type.Literal("add"),
		Type.Literal("restore"),
		Type.Literal("commit"),
		Type.Literal("checkout"),
		Type.Literal("merge"),
		Type.Literal("rebase"),
		Type.Literal("stash"),
		Type.Literal("cherry-pick"),
		Type.Literal("fetch"),
		Type.Literal("pull"),
		Type.Literal("push"),
		Type.Literal("tag"),
		Type.Literal("pr"),
		Type.Literal("issue"),
		Type.Literal("ci"),
		Type.Literal("release"),
	]),

	// Status
	only: Type.Optional(
		Type.Union([
			Type.Literal("branch"),
			Type.Literal("modified"),
			Type.Literal("staged"),
			Type.Literal("untracked"),
			Type.Literal("conflicts"),
			Type.Literal("sync"),
		]),
	),
	ignored: Type.Optional(Type.Boolean()),

	// Diff
	target: Type.Optional(
		Type.Union([
			Type.Literal("unstaged"),
			Type.Literal("staged"),
			Type.Literal("head"),
			Type.Object({
				from: Type.String(),
				to: Type.Optional(Type.String()),
			}),
			Type.String(),
		]),
	),
	paths: Type.Optional(Type.Array(Type.String())),
	stat_only: Type.Optional(Type.Boolean()),
	name_only: Type.Optional(Type.Boolean()),
	context: Type.Optional(Type.Number()),
	max_lines: Type.Optional(Type.Number()),
	ignore_whitespace: Type.Optional(Type.Boolean()),

	// Log
	limit: Type.Optional(Type.Number()),
	ref: Type.Optional(Type.String()),
	author: Type.Optional(Type.String()),
	since: Type.Optional(Type.String()),
	until: Type.Optional(Type.String()),
	grep: Type.Optional(Type.String()),
	format: Type.Optional(Type.Union([Type.Literal("oneline"), Type.Literal("short"), Type.Literal("full")])),
	stat: Type.Optional(Type.Boolean()),
	merges: Type.Optional(Type.Boolean()),
	first_parent: Type.Optional(Type.Boolean()),

	// Show
	path: Type.Optional(Type.String()),
	diff: Type.Optional(Type.Boolean()),
	lines: Type.Optional(
		Type.Object({
			start: Type.Number(),
			end: Type.Number(),
		}),
	),

	// Blame
	root: Type.Optional(Type.Boolean()),

	// Branch
	action: Type.Optional(
		Type.Union([
			Type.Literal("list"),
			Type.Literal("create"),
			Type.Literal("delete"),
			Type.Literal("rename"),
			Type.Literal("current"),
		]),
	),
	name: Type.Optional(Type.String()),
	newName: Type.Optional(Type.String()),
	startPoint: Type.Optional(Type.String()),
	remotes: Type.Optional(Type.Boolean()),
	force: Type.Optional(Type.Boolean()),

	// Add/Restore
	update: Type.Optional(Type.Boolean()),
	all: Type.Optional(Type.Boolean()),
	dry_run: Type.Optional(Type.Boolean()),
	staged: Type.Optional(Type.Boolean()),
	worktree: Type.Optional(Type.Boolean()),
	source: Type.Optional(Type.String()),

	// Commit
	message: Type.Optional(Type.String()),
	allow_empty: Type.Optional(Type.Boolean()),
	sign: Type.Optional(Type.Boolean()),
	no_verify: Type.Optional(Type.Boolean()),
	amend: Type.Optional(Type.Boolean()),

	// Checkout
	create: Type.Optional(Type.Boolean()),

	// Merge
	no_ff: Type.Optional(Type.Boolean()),
	ff_only: Type.Optional(Type.Boolean()),
	squash: Type.Optional(Type.Boolean()),
	abort: Type.Optional(Type.Boolean()),
	continue: Type.Optional(Type.Boolean()),

	// Rebase
	onto: Type.Optional(Type.String()),
	upstream: Type.Optional(Type.String()),
	skip: Type.Optional(Type.Boolean()),

	// Stash
	include_untracked: Type.Optional(Type.Boolean()),
	index: Type.Optional(Type.Number()),
	keep_index: Type.Optional(Type.Boolean()),

	// Cherry-pick
	commits: Type.Optional(Type.Array(Type.String())),
	no_commit: Type.Optional(Type.Boolean()),

	// Fetch/Pull/Push/Tag
	remote: Type.Optional(Type.String()),
	branch: Type.Optional(Type.String()),
	prune: Type.Optional(Type.Boolean()),
	tags: Type.Optional(Type.Boolean()),
	rebase: Type.Optional(Type.Boolean()),
	set_upstream: Type.Optional(Type.Boolean()),
	force_with_lease: Type.Optional(Type.Boolean()),
	delete: Type.Optional(Type.Boolean()),
	force_override: Type.Optional(Type.Boolean()),

	// Tag
	// (name/message/ref already covered)

	// PR
	number: Type.Optional(Type.Number()),
	title: Type.Optional(Type.String()),
	body: Type.Optional(Type.String()),
	base: Type.Optional(Type.String()),
	head: Type.Optional(Type.String()),
	draft: Type.Optional(Type.Boolean()),
	state: Type.Optional(
		Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("merged"), Type.Literal("all")]),
	),
	merge_method: Type.Optional(Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")])),
	review_action: Type.Optional(
		Type.Union([Type.Literal("approve"), Type.Literal("request-changes"), Type.Literal("comment")]),
	),
	review_body: Type.Optional(Type.String()),

	// Issue
	labels: Type.Optional(Type.Array(Type.String())),
	assignee: Type.Optional(Type.String()),
	comment_body: Type.Optional(Type.String()),

	// CI
	workflow: Type.Optional(Type.String()),
	run_id: Type.Optional(Type.Number()),
	inputs: Type.Optional(Type.Record(Type.String(), Type.String())),
	logs_failed: Type.Optional(Type.Boolean()),

	// Release
	notes: Type.Optional(Type.String()),
	generate_notes: Type.Optional(Type.Boolean()),
	prerelease: Type.Optional(Type.Boolean()),
	assets: Type.Optional(Type.Array(Type.String())),
});

export type GitToolDetails = ToolResponse<unknown>;

export function createGitTool(session: ToolSession): AgentTool<typeof gitSchema, GitToolDetails> | null {
	if (session.settings?.getGitToolEnabled() === false) {
		return null;
	}
	return {
		name: "git",
		label: "Git",
		description: renderPromptTemplate(gitDescription),
		parameters: gitSchema,
		execute: async (_toolCallId, params: Static<typeof gitSchema>, _signal?: AbortSignal) => {
			if (params.operation === "commit" && !params.message) {
				throw new Error("Git commit requires a message to avoid an interactive editor. Provide `message`.");
			}

			const result = await gitToolCore(params as GitParams, session.cwd);
			if ("error" in result) {
				const message = result._rendered ?? result.error;
				return { content: [{ type: "text", text: message }], details: result };
			}
			if ("confirm" in result) {
				const message = result._rendered ?? result.confirm;
				return { content: [{ type: "text", text: message }], details: result };
			}
			return { content: [{ type: "text", text: result._rendered }], details: result };
		},
	};
}

export const gitTool = createGitTool({
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
})!;
