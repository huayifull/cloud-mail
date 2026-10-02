import { pinyin } from 'pinyin-pro';

export function nameToMailboxLocalPart(name) {
	if (typeof name !== 'string' || !name.trim()) return null;
	const localPart = pinyin(name.trim(), { toneType: 'none', type: 'array' })
		.join('')
		.replaceAll('ü', 'v')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '')
		.slice(0, 56);
	return localPart || null;
}

export async function allocateMailboxAddress({ name, domain, isTaken }) {
	const localPart = nameToMailboxLocalPart(name);
	const normalizedDomain = String(domain || '').trim().toLowerCase();
	if (!localPart || !normalizedDomain) return null;

	for (let sequence = 1; sequence <= 9999; sequence++) {
		const suffix = sequence === 1 ? '' : String(sequence);
		const candidate = `${localPart}${suffix}@${normalizedDomain}`;
		if (!await isTaken(candidate)) return candidate;
	}
	return null;
}
