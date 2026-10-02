import BizError from '../error/biz-error';

const encoder = new TextEncoder();

function hexToBytes(value) {
	if (!/^[a-f0-9]{64}$/i.test(value)) return null;
	const bytes = new Uint8Array(value.length / 2);
	for (let index = 0; index < value.length; index += 2) {
		bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
	}
	return bytes;
}

export async function verifyIdentitySignature({ body, timestamp, signature, secret, nowSeconds }) {
	const timestampNumber = Number(timestamp);
	if (!Number.isInteger(timestampNumber) || Math.abs(nowSeconds - timestampNumber) > 300) return false;
	const signatureBytes = hexToBytes(signature || '');
	if (!signatureBytes || !secret) return false;

	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify'],
	);
	return crypto.subtle.verify(
		'HMAC',
		key,
		signatureBytes,
		encoder.encode(`${timestamp}.${body}`),
	);
}

export async function verifyIdentityRequest(c, body) {
	const secret = c.env.IDENTITY_SYNC_SECRET;
	if (!secret) throw new BizError('员工同步未配置', 503);

	const timestamp = c.req.header('X-Identity-Timestamp');
	const signature = c.req.header('X-Identity-Signature');
	const valid = await verifyIdentitySignature({
		body,
		timestamp,
		signature,
		secret,
		nowSeconds: Math.floor(Date.now() / 1000),
	});
	if (!valid) throw new BizError('员工同步签名无效或已过期', 401);
}
