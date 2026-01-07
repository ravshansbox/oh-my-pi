/**
 * Shared types and utilities for web-fetch handlers
 */

export interface RenderResult {
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	content: string;
	fetchedAt: string;
	truncated: boolean;
	notes: string[];
}

export type SpecialHandler = (url: string, timeout: number) => Promise<RenderResult | null>;

export const MAX_OUTPUT_CHARS = 500_000;

/**
 * Truncate and cleanup output
 */
export function finalizeOutput(content: string): { content: string; truncated: boolean } {
	const cleaned = content.replace(/\n{3,}/g, "\n\n").trim();
	const truncated = cleaned.length > MAX_OUTPUT_CHARS;
	return {
		content: cleaned.slice(0, MAX_OUTPUT_CHARS),
		truncated,
	};
}

/**
 * Fetch a page with timeout and size limit
 */
export async function loadPage(
	url: string,
	options: { timeout?: number; headers?: Record<string, string>; maxBytes?: number } = {},
): Promise<{ content: string; contentType: string; finalUrl: string; ok: boolean; status?: number }> {
	const { timeout = 20, headers = {}, maxBytes = 50 * 1024 * 1024 } = options;

	const userAgents = [
		"curl/8.0",
		"Mozilla/5.0 (compatible; TextBot/1.0)",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
	];

	for (let attempt = 0; attempt < userAgents.length; attempt++) {
		const userAgent = userAgents[attempt];

		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

			const response = await fetch(url, {
				signal: controller.signal,
				headers: {
					"User-Agent": userAgent,
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.5",
					...headers,
				},
				redirect: "follow",
			});

			clearTimeout(timeoutId);

			const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
			const finalUrl = response.url;

			const reader = response.body?.getReader();
			if (!reader) {
				return { content: "", contentType, finalUrl, ok: false, status: response.status };
			}

			const chunks: Uint8Array[] = [];
			let totalSize = 0;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				chunks.push(value);
				totalSize += value.length;

				if (totalSize > maxBytes) {
					reader.cancel();
					break;
				}
			}

			const decoder = new TextDecoder();
			const content = decoder.decode(Buffer.concat(chunks));

			// Check if blocked
			if ((response.status === 403 || response.status === 503) && attempt < userAgents.length - 1) {
				const lower = content.toLowerCase();
				if (lower.includes("cloudflare") || lower.includes("captcha") || lower.includes("blocked")) {
					continue;
				}
			}

			if (!response.ok) {
				return { content, contentType, finalUrl, ok: false, status: response.status };
			}

			return { content, contentType, finalUrl, ok: true, status: response.status };
		} catch (_err) {
			if (attempt === userAgents.length - 1) {
				return { content: "", contentType: "", finalUrl: url, ok: false };
			}
		}
	}

	return { content: "", contentType: "", finalUrl: url, ok: false };
}

/**
 * Format large numbers (1000 -> 1K, 1000000 -> 1M)
 */
export function formatCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

/**
 * Convert basic HTML to markdown
 */
export function htmlToBasicMarkdown(html: string): string {
	return html
		.replace(/<pre><code[^>]*>/g, "\n```\n")
		.replace(/<\/code><\/pre>/g, "\n```\n")
		.replace(/<code>/g, "`")
		.replace(/<\/code>/g, "`")
		.replace(/<strong>/g, "**")
		.replace(/<\/strong>/g, "**")
		.replace(/<b>/g, "**")
		.replace(/<\/b>/g, "**")
		.replace(/<em>/g, "*")
		.replace(/<\/em>/g, "*")
		.replace(/<i>/g, "*")
		.replace(/<\/i>/g, "*")
		.replace(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g, "[$2]($1)")
		.replace(/<p>/g, "\n\n")
		.replace(/<\/p>/g, "")
		.replace(/<br\s*\/?>/g, "\n")
		.replace(/<li>/g, "- ")
		.replace(/<\/li>/g, "\n")
		.replace(/<\/?[uo]l>/g, "\n")
		.replace(/<h(\d)>/g, (_, n) => `\n${"#".repeat(parseInt(n, 10))} `)
		.replace(/<\/h\d>/g, "\n")
		.replace(/<blockquote>/g, "\n> ")
		.replace(/<\/blockquote>/g, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
