import app from '../hono/hono';
import BizError from '../error/biz-error';
import result from '../model/result';
import { verifyIdentitySignature } from '../security/identity-event';
import { provisionStoreMailbox } from '../service/store-mailbox-service';

app.post('/internal/store-mailboxes', async (c) => {
	try {
		if (!c.env.STORE_MAILBOX_SECRET) throw new BizError('店铺邮箱同步未配置', 503);
		const body = await c.req.text();
		if (body.length > 4096) throw new BizError('请求过大', 400);
		if (!await verifyIdentitySignature({ body, secret: c.env.STORE_MAILBOX_SECRET,
			timestamp: c.req.header('X-Store-Timestamp'), signature: c.req.header('X-Store-Signature'),
			nowSeconds: Math.floor(Date.now() / 1000) })) throw new BizError('店铺邮箱签名无效或已过期', 401);
		let input;
		try { input = JSON.parse(body); } catch { throw new BizError('无效 JSON', 400); }
		return c.json(result.ok(await provisionStoreMailbox(c, input)));
	} catch (error) {
		if (error instanceof BizError) return c.json(result.fail(error.message, error.code), error.code);
		throw error;
	}
});
