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
		const parts = [frontmatter, '', `# ${title}`, '', detail.aiContentMarkdown];

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
