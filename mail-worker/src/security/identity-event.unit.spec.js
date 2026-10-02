import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyIdentitySignature } from './identity-event';
import { allocateMailboxAddress, nameToMailboxLocalPart } from '../service/mailbox-address';

describe('employee identity event security', () => {
	it('converts employee names to stable ASCII mailbox names', async () => {
		expect(nameToMailboxLocalPart('张三')).toBe('zhangsan');
		expect(nameToMailboxLocalPart('吕布')).toBe('lvbu');
		expect(nameToMailboxLocalPart('John 王')).toBe('johnwang');
		expect(nameToMailboxLocalPart('  ')).toBeNull();

		const used = new Set(['zhangsan@huayimail.com']);
		await expect(allocateMailboxAddress({
			name: '张三',
			domain: 'huayimail.com',
			isTaken: async candidate => used.has(candidate),
		})).resolves.toBe('zhangsan2@huayimail.com');
	});

	it('accepts a fresh HMAC and rejects replayed timestamps', async () => {
		const secret = 'test-secret';
		const body = '{"event_id":"evt-1"}';
		const timestamp = '1000';
		const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

		await expect(verifyIdentitySignature({ body, timestamp, signature, secret, nowSeconds: 1100 }))
			.resolves.toBe(true);
		await expect(verifyIdentitySignature({ body, timestamp, signature, secret, nowSeconds: 1401 }))
			.resolves.toBe(false);
	});
});
