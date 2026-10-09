import BizError from '../error/biz-error';

export function storeMailboxInput(input, domains) {
	if (!input || !/^[0-9]{1,20}$/.test(input.store_id || '') ||
		typeof input.name !== 'string' || !input.name.trim() || input.name.length > 255) {
		throw new BizError('店铺 ID 或名称无效', 400);
	}
	if (!Array.isArray(domains) || !domains.includes('huayimail.com')) {
		throw new BizError('店铺邮箱域名未配置', 503);
	}
	return { email: `shein.${input.store_id}@huayimail.com`, name: input.name.trim() };
}

export async function provisionStoreMailbox(c, input) {
	const { email, name } = storeMailboxInput(input, c.env.domain);
	const owner = await c.env.db.prepare('SELECT user_id,status,is_del FROM user WHERE email=? COLLATE NOCASE')
		.bind(c.env.admin).first();
	if (!owner || owner.status !== 0 || owner.is_del !== 0) throw new BizError('邮箱管理员不可用', 503);
	const settings = await c.env.db.prepare('SELECT receive FROM setting LIMIT 1').first();
	if (!settings || settings.receive !== 0) throw new BizError('邮箱收件服务已关闭', 503);
	// Unique email index plus conditional insert makes concurrent retries safe.
	await c.env.db.prepare(`INSERT INTO account(email,name,user_id)
		SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM account WHERE email=? COLLATE NOCASE)
		ON CONFLICT DO NOTHING`).bind(email, name, owner.user_id, email).run();
	const mailbox = await c.env.db.prepare('SELECT account_id,email,user_id,status,is_del FROM account WHERE email=? COLLATE NOCASE')
		.bind(email).first();
	if (!mailbox || mailbox.user_id !== owner.user_id || mailbox.is_del !== 0 || mailbox.status !== 0) {
		throw new BizError('邮箱已存在但归属或状态冲突，需要人工核验', 409);
	}
	return { email: mailbox.email, account_id: mailbox.account_id, status: 'READY' };
}
