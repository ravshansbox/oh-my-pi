import { tmpdir } from "node:os";
import * as path from "node:path";
import { ensureTool } from "../../../utils/tools-manager";

const MAX_BYTES = 50 * 1024 * 1024; // 50MB for binary files

function exec(
	cmd: string,
	args: string[],
	options?: { timeout?: number; input?: string | Buffer },
): { stdout: string; stderr: string; ok: boolean } {
	const result = Bun.spawnSync([cmd, ...args], {
		stdin: options?.input ? (options.input as any) : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		stdout: result.stdout?.toString() ?? "",
		stderr: result.stderr?.toString() ?? "",
		ok: result.exitCode === 0,
	};
}

export async function convertWithMarkitdown(
	content: Buffer,
	extensionHint: string,
	timeout: number,
): Promise<{ content: string; ok: boolean }> {
	const markitdown = await ensureTool("markitdown", true);
	if (!markitdown) {
		return { content: "", ok: false };
	}

	// Write to temp file with extension hint
	const ext = extensionHint || ".bin";
	const tmpDir = tmpdir();
	const tmpFile = path.join(tmpDir, `omp-convert-${Date.now()}${ext}`);

	try {
		await Bun.write(tmpFile, content);
		const result = exec(markitdown, [tmpFile], { timeout });
		return { content: result.stdout, ok: result.ok };
	} finally {
		try {
			await Bun.$`rm ${tmpFile}`.quiet();
		} catch {}
	}
}

export async function fetchBinary(
	url: string,
	timeout: number,
): Promise<{ buffer: Buffer; contentType: string; contentDisposition?: string; ok: boolean }> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0",
			},
			redirect: "follow",
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			return { buffer: Buffer.alloc(0), contentType: "", ok: false };
		}

		const contentType = response.headers.get("content-type") ?? "";
		const contentDisposition = response.headers.get("content-disposition") ?? undefined;
		const contentLength = response.headers.get("content-length");
		if (contentLength) {
			const size = Number.parseInt(contentLength, 10);
			if (Number.isFinite(size) && size > MAX_BYTES) {
				return { buffer: Buffer.alloc(0), contentType, contentDisposition, ok: false };
			}
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		if (buffer.length > MAX_BYTES) {
			return { buffer: Buffer.alloc(0), contentType, contentDisposition, ok: false };
		}

		return { buffer, contentType, contentDisposition, ok: true };
	} catch {
		return { buffer: Buffer.alloc(0), contentType: "", ok: false };
	}
}
