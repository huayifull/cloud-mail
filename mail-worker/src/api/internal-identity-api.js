import app from '../hono/hono';
import BizError from '../error/biz-error';
import result from '../model/result';
import { verifyIdentityRequest } from '../security/identity-event';
import identityService from '../service/identity-service';

app.post('/internal/identity-events', async (c) => {
	try {
		const body = await c.req.text();
		await verifyIdentityRequest(c, body);

		let event;
		try {
			event = JSON.parse(body);
		} catch {
			throw new BizError('员工同步事件不是有效 JSON', 400);
		}

		const headerEventId = c.req.header('X-Identity-Event-ID');
		if (!headerEventId || headerEventId !== event.event_id) {
			throw new BizError('员工同步事件 ID 不一致', 400);
		}

		return c.json(result.ok(await identityService.reconcile(c, event)));
	} catch (error) {
		if (error instanceof BizError) {
			return c.json(result.fail(error.message, error.code), error.code);
		}
		throw error;
	}
});
