import { createHmac } from 'node:crypto';
import { env, SELF } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';

function request(signature) {
	const body = JSON.stringify({store_id:'8245046553',name:'测试店铺'});
	const timestamp = String(Math.floor(Date.now()/1000));
	return new Request('https://example.com/api/internal/store-mailboxes', {method:'POST',body,
		headers:{'Content-Type':'application/json','X-Store-Timestamp':timestamp,
			'X-Store-Signature':signature || createHmac('sha256','store-mailbox-test-secret').update(`${timestamp}.${body}`).digest('hex')}});
}
beforeAll(async () => {
	const response = await SELF.fetch('http://example.com/api/init/b7f29a1d-18e2-4d3b-941f-f6b2c97c02fd');
	expect(await response.text()).toBe('success');
});
it('rejects unsigned requests and safely replays concurrent provisioning', async () => {
	expect((await SELF.fetch(request('0'.repeat(64)))).status).toBe(401);
	const responses = await Promise.all([SELF.fetch(request()), SELF.fetch(request())]);
	for (const response of responses) {
		expect(response.status).toBe(200);
		expect((await response.json()).data).toMatchObject({email:'shein.8245046553@huayimail.com',status:'READY'});
	}
	const rows = await env.db.prepare('SELECT a.account_id,a.user_id,u.email AS owner FROM account a JOIN user u ON a.user_id=u.user_id WHERE a.email=?')
		.bind('shein.8245046553@huayimail.com').all();
	expect(rows.results).toHaveLength(1);
	expect(rows.results[0].owner).toBe('admin@example.com');
});
