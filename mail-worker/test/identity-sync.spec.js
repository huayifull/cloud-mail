import { createHmac } from 'node:crypto';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

const syncSecret = 'identity-test-secret';

function signedRequest(event, signatureOverride) {
	const body = JSON.stringify(event);
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = signatureOverride || createHmac('sha256', syncSecret)
		.update(`${timestamp}.${body}`)
		.digest('hex');
	return new Request('http://example.com/api/internal/identity-events', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Identity-Event-ID': event.event_id,
			'X-Identity-Timestamp': timestamp,
			'X-Identity-Signature': signature,
		},
		body,
	});
}

function employeeEvent(overrides = {}) {
	return {
		schema_version: 1,
		event_id: 'evt-active',
		event_type: 'employee.activated',
		occurred_at: new Date().toISOString(),
		employee_id: 'employee-1',
		feishu_user_id: 'feishu-1',
		keycloak_user_id: 'keycloak-1',
		name: '张三',
		email: 'alice@huayifull.com',
		status: 'ACTIVE',
		department_ids: ['department-1'],
		...overrides,
	};
}

describe('managed employee mailbox reconciliation', () => {
	beforeAll(async () => {
		const response = await SELF.fetch('http://example.com/api/init/b7f29a1d-18e2-4d3b-941f-f6b2c97c02fd');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('success');
	});

	it('creates, replays and disables one stable mailbox', async () => {
		const active = employeeEvent();
		let response = await SELF.fetch(signedRequest(active));
		expect(response.status).toBe(200);
		expect((await response.json()).data).toMatchObject({
			status: 'ACTIVE',
			mailboxEmail: 'zhangsan@example.com',
		});

		response = await SELF.fetch(signedRequest(active));
		expect(response.status).toBe(200);
		expect((await env.db.prepare(`SELECT count(*) AS count FROM user WHERE email = ?`)
			.bind('zhangsan@example.com').first()).count).toBe(1);

		const disabled = employeeEvent({
			event_id: 'evt-disabled',
			event_type: 'employee.deactivated',
			status: 'DISABLED',
		});
		response = await SELF.fetch(signedRequest(disabled));
		expect(response.status).toBe(200);
		expect((await response.json()).data.status).toBe('DISABLED');
		expect((await env.db.prepare(`SELECT status FROM user WHERE email = ?`)
			.bind('zhangsan@example.com').first()).status).toBe(1);
	});

	it('adds a numeric suffix when two employees have the same name', async () => {
		const first = employeeEvent({
			event_id: 'evt-first-same-name',
			employee_id: 'employee-first',
			feishu_user_id: 'feishu-first',
			keycloak_user_id: 'keycloak-first',
		});
		expect((await SELF.fetch(signedRequest(first))).status).toBe(200);

		const duplicateName = employeeEvent({
			event_id: 'evt-duplicate-name',
			employee_id: 'employee-2',
			feishu_user_id: 'feishu-2',
			keycloak_user_id: 'keycloak-2',
			email: 'employee@qq.com',
		});
		const response = await SELF.fetch(signedRequest(duplicateName));
		expect(response.status).toBe(200);
		expect((await response.json()).data).toMatchObject({
			status: 'ACTIVE',
			mailboxEmail: 'zhangsan2@example.com',
		});
		expect((await env.db.prepare(`SELECT count(*) AS count FROM user WHERE email = ?`)
			.bind('zhangsan2@example.com').first()).count).toBe(1);
	});

	it('keeps an employee with no usable name pending', async () => {
		const pending = employeeEvent({
			event_id: 'evt-pending-name',
			employee_id: 'employee-3',
			feishu_user_id: 'feishu-3',
			keycloak_user_id: 'keycloak-3',
			name: '  ',
		});
		const response = await SELF.fetch(signedRequest(pending));
		expect(response.status).toBe(200);
		expect((await response.json()).data.status).toBe('PENDING_NAME');
	});

	it('rejects an invalid signature with a real HTTP error', async () => {
		const response = await SELF.fetch(signedRequest(
			employeeEvent({ event_id: 'evt-invalid' }),
			'0'.repeat(64),
		));
		expect(response.status).toBe(401);
		expect((await response.json()).code).toBe(401);
	});
});
