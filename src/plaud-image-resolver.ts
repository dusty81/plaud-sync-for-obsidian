import type {PlaudVaultAdapter} from './plaud-vault';

export interface ImageSignedUrl {
	/** The relative S3 path, e.g. "permanent/abc123/summary_poster/card_123.png" */
	relativePath: string;
	/** The full signed URL for downloading */
	signedUrl: string;
}

const PLAUD_S3_BASE = 'https://prod-plaud-content-storage.s3.amazonaws.com';

export interface ResolveImagesInput {
	vault: PlaudVaultAdapter;
	syncFolder: string;
	markdown: string;
	imageUrls: ImageSignedUrl[];
	fetchBinary: (url: string) => Promise<ArrayBuffer>;
}

export interface ResolveImagesResult {
	markdown: string;
	downloaded: number;
}

const IMAGE_REF_PATTERN = /!\[([^\]]*)\]\(([^)]+\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?[^)]*)?)\)/gi;

function extractRelativePath(ref: string): string {
	return ref.replace(/\?.*$/, '').trim();
}

function deriveLocalFilename(relativePath: string): string {
	const lastSlash = relativePath.lastIndexOf('/');
	return lastSlash >= 0 ? relativePath.slice(lastSlash + 1) : relativePath;
}

export function extractImageRefs(markdown: string): string[] {
	const refs: string[] = [];
	for (const match of markdown.matchAll(IMAGE_REF_PATTERN)) {
		const ref = match[2];
		if (ref) {
			refs.push(extractRelativePath(ref));
		}
	}
	return refs;
}

function collectSignedImageUrls(value: unknown, results: ImageSignedUrl[]): void {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed.startsWith('http')) {
			return;
		}

		try {
			const url = new URL(trimmed);
			const decodedPath = decodeURIComponent(url.pathname).replace(/^\//, '');
			if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(decodedPath)) {
				results.push({relativePath: decodedPath, signedUrl: trimmed});
			}
		} catch {
			// not a valid URL
		}
		return;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			collectSignedImageUrls(item, results);
		}
		return;
	}

	if (typeof value === 'object' && value !== null) {
		for (const v of Object.values(value)) {
			collectSignedImageUrls(v, results);
		}
	}
}

export function buildSignedUrlMap(rawDetail: unknown): ImageSignedUrl[] {
	const results: ImageSignedUrl[] = [];
	collectSignedImageUrls(rawDetail, results);

	const seen = new Set<string>();
	return results.filter((entry) => {
		if (seen.has(entry.relativePath)) {
			return false;
		}
		seen.add(entry.relativePath);
		return true;
	});
}

function firstNonEmpty(values: unknown[]): string {
	for (const v of values) {
		if (typeof v === 'string' && v.trim()) {
			return v.trim();
		}
	}
	return '';
}

function findSignedUrl(relativePath: string, imageUrls: ImageSignedUrl[]): string | undefined {
	for (const entry of imageUrls) {
		if (entry.relativePath === relativePath) {
			return entry.signedUrl;
		}

		if (relativePath.includes('@') && entry.relativePath.includes('%40')) {
			const decoded = entry.relativePath.replace(/%40/g, '@');
			if (decoded === relativePath) {
				return entry.signedUrl;
			}
		}

		if (entry.relativePath.includes('@') && relativePath.includes('%40')) {
			const decoded = relativePath.replace(/%40/g, '@');
			if (decoded === entry.relativePath) {
				return entry.signedUrl;
			}
		}
	}

	return undefined;
}

export async function resolveImages(input: ResolveImagesInput): Promise<ResolveImagesResult> {
	const refs = extractImageRefs(input.markdown);
	if (refs.length === 0) {
		return {markdown: input.markdown, downloaded: 0};
	}

	const assetsFolder = `${input.syncFolder}/assets`;
	await input.vault.ensureFolder(assetsFolder);

	let markdown = input.markdown;
	let downloaded = 0;

	for (const ref of refs) {
		const signedUrl = findSignedUrl(ref, input.imageUrls);
		const encodedPath = ref.replace(/@/g, '%40');
		const fallbackUrl = `${PLAUD_S3_BASE}/${encodedPath}`;
		const urlsToTry = signedUrl ? [signedUrl, fallbackUrl] : [fallbackUrl];

		const localFilename = deriveLocalFilename(ref);
		const localPath = `${assetsFolder}/${localFilename}`;

		for (const url of urlsToTry) {
			try {
				const data = await input.fetchBinary(url);
				await input.vault.createBinary(localPath, data);

				markdown = markdown.split(ref).join(`assets/${localFilename}`);
				downloaded += 1;
				break;
			} catch {
				// try next URL or give up
			}
		}
	}

	return {markdown, downloaded};
}
