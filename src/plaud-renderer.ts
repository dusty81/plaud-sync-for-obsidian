import type {NormalizedPlaudDetail} from './plaud-normalizer';

function formatDate(timestampMs: number): string {
	if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
		return '1970-01-01';
	}
	return new Date(timestampMs).toISOString().slice(0, 10);
}

function formatDuration(durationMs: number): string {
	if (!Number.isFinite(durationMs) || durationMs <= 0) {
		return '0 min';
	}
	return `${Math.round(durationMs / 60000)} min`;
}

function normalizeTitle(title: string): string {
	const trimmed = title.trim();
	return trimmed.length > 0 ? trimmed : 'Untitled recording';
}

function escapeFrontmatterValue(value: string): string {
	return value.replace(/"/g, '\\"');
}

const HEADER_IN_TABLE_ROW = /^\|\s*(.+?)\s*\|(?:\s*\|)*\s*$/;

function isHeaderRow(line: string): boolean {
	const match = line.match(HEADER_IN_TABLE_ROW);
	if (!match) {
		return false;
	}

	const cells = line.split('|').slice(1, -1);
	if (cells.length < 2) {
		return false;
	}

	const nonEmpty = cells.filter((c) => c.trim().length > 0);
	if (nonEmpty.length !== 1) {
		return false;
	}

	const content = nonEmpty[0]?.trim() ?? '';
	return /\*\*/.test(content);
}

function extractHeadersFromTables(markdown: string): string {
	const lines = markdown.split('\n');
	const result: string[] = [];

	for (const line of lines) {
		if (isHeaderRow(line)) {
			const content = line.split('|').slice(1, -1)
				.map((c) => c.trim())
				.filter((c) => c.length > 0)[0] ?? '';
			result.push(content);
		} else {
			result.push(line);
		}
	}

	return result.join('\n');
}

function ensureBlankLinesAroundTables(markdown: string): string {
	const lines = markdown.split('\n');
	const result: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		const prev = i > 0 ? (lines[i - 1] ?? '') : '';
		const isTableRow = line.trimStart().startsWith('|');
		const prevIsTableRow = prev.trimStart().startsWith('|');

		if (isTableRow && !prevIsTableRow && prev.trim() !== '') {
			result.push('');
		}

		result.push(line);

		const next = i < lines.length - 1 ? (lines[i + 1] ?? '') : '';
		const nextIsTableRow = next.trimStart().startsWith('|');
		if (isTableRow && !nextIsTableRow && next.trim() !== '') {
			result.push('');
		}
	}

	return result.join('\n');
}

function renderHighlights(highlights: string[]): string {
	if (highlights.length === 0) {
		return '- No highlights extracted.';
	}

	return highlights.map((highlight) => `- ${highlight}`).join('\n');
}

export function renderPlaudMarkdown(detail: NormalizedPlaudDetail): string {
	const title = normalizeTitle(detail.title);
	const date = formatDate(detail.startAtMs);
	const duration = formatDuration(detail.durationMs);

	const frontmatter = [
		'---',
		'source: plaud',
		'type: recording',
		`file_id: ${detail.fileId}`,
		`title: "${escapeFrontmatterValue(title)}"`,
		`date: ${date}`,
		`duration: ${duration}`,
		'---'
	].join('\n');

	if (detail.aiContentMarkdown) {
		const cleaned = extractHeadersFromTables(detail.aiContentMarkdown);
		const parts = [frontmatter, '', `# ${title}`, '', ensureBlankLinesAroundTables(cleaned)];

		const transcript = detail.transcript.trim();
		if (transcript) {
			const calloutBody = transcript.split('\n').map((line) => `> ${line}`).join('\n');
			parts.push('', '> [!note]- Transcript', calloutBody);
		}

		parts.push('');
		return parts.join('\n');
	}

	const summary = detail.summary.trim() || 'No summary available.';
	const transcript = detail.transcript.trim() || 'No transcript available.';

	return [
		frontmatter,
		'',
		`# ${title}`,
		'',
		'## Summary',
		summary,
		'',
		'## Highlights',
		renderHighlights(detail.highlights),
		'',
		'## Transcript',
		transcript,
		''
	].join('\n');
}
