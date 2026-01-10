import { describe, expect, it } from "bun:test";
import { BUILTIN_TOOLS, createTools, HIDDEN_TOOLS, type ToolSession } from "./index";

function createTestSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		...overrides,
	};
}

describe("createTools", () => {
	it("creates all builtin tools by default", async () => {
		const session = createTestSession();
		const tools = await createTools(session);
		const names = tools.map((t) => t.name);

		// Core tools should always be present
		expect(names).toContain("bash");
		expect(names).toContain("calc");
		expect(names).toContain("read");
		expect(names).toContain("edit");
		expect(names).toContain("write");
		expect(names).toContain("grep");
		expect(names).toContain("find");
		expect(names).toContain("ls");
		expect(names).toContain("lsp");
		expect(names).toContain("notebook");
		expect(names).toContain("task");
		expect(names).toContain("output");
		expect(names).toContain("web_fetch");
		expect(names).toContain("web_search");
	});

	it("respects requested tool subset", async () => {
		const session = createTestSession();
		const tools = await createTools(session, ["read", "write"]);
		const names = tools.map((t) => t.name);

		expect(names).toEqual(["read", "write"]);
	});

	it("includes hidden tools when explicitly requested", async () => {
		const session = createTestSession();
		const tools = await createTools(session, ["report_finding"]);
		const names = tools.map((t) => t.name);

		expect(names).toEqual(["report_finding"]);
	});

	it("includes complete tool when required", async () => {
		const session = createTestSession({ requireCompleteTool: true });
		const tools = await createTools(session);
		const names = tools.map((t) => t.name);

		expect(names).toContain("complete");
	});

	it("excludes ask tool when hasUI is false", async () => {
		const session = createTestSession({ hasUI: false });
		const tools = await createTools(session);
		const names = tools.map((t) => t.name);

		expect(names).not.toContain("ask");
	});

	it("includes ask tool when hasUI is true", async () => {
		const session = createTestSession({ hasUI: true });
		const tools = await createTools(session);
		const names = tools.map((t) => t.name);

		expect(names).toContain("ask");
	});

	it("excludes git tool when disabled in settings", async () => {
		const session = createTestSession({
			settings: {
				getImageAutoResize: () => true,
				getLspFormatOnWrite: () => true,
				getLspDiagnosticsOnWrite: () => true,
				getLspDiagnosticsOnEdit: () => false,
				getEditFuzzyMatch: () => true,
				getGitToolEnabled: () => false,
				getBashInterceptorEnabled: () => true,
				getBashInterceptorSimpleLsEnabled: () => true,
				getBashInterceptorRules: () => [],
			},
		});
		const tools = await createTools(session);
		const names = tools.map((t) => t.name);

		expect(names).not.toContain("git");
	});

	it("includes git tool when enabled in settings", async () => {
		const session = createTestSession({
			settings: {
				getImageAutoResize: () => true,
				getLspFormatOnWrite: () => true,
				getLspDiagnosticsOnWrite: () => true,
				getLspDiagnosticsOnEdit: () => false,
				getEditFuzzyMatch: () => true,
				getGitToolEnabled: () => true,
				getBashInterceptorEnabled: () => true,
				getBashInterceptorSimpleLsEnabled: () => true,
				getBashInterceptorRules: () => [],
			},
		});
		const tools = await createTools(session);
		const names = tools.map((t) => t.name);

		expect(names).toContain("git");
	});

	it("includes git tool when no settings provided (default enabled)", async () => {
		const session = createTestSession({ settings: undefined });
		const tools = await createTools(session);
		const names = tools.map((t) => t.name);

		expect(names).toContain("git");
	});

	it("always includes output tool when task tool is present", async () => {
		const session = createTestSession();
		const tools = await createTools(session);
		const names = tools.map((t) => t.name);

		// Both should be present together
		expect(names).toContain("task");
		expect(names).toContain("output");
	});

	it("BUILTIN_TOOLS contains all expected tools", () => {
		const expectedTools = [
			"ask",
			"bash",
			"calc",
			"ssh",
			"edit",
			"find",
			"git",
			"grep",
			"ls",
			"lsp",
			"notebook",
			"output",
			"read",
			"task",
			"web_fetch",
			"web_search",
			"write",
		];

		for (const tool of expectedTools) {
			expect(BUILTIN_TOOLS).toHaveProperty(tool);
		}

		// Ensure we haven't missed any
		expect(Object.keys(BUILTIN_TOOLS).sort()).toEqual(expectedTools.sort());
	});

	it("HIDDEN_TOOLS contains review tools", () => {
		expect(Object.keys(HIDDEN_TOOLS).sort()).toEqual(["complete", "report_finding"]);
	});
});
