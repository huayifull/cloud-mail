import BizError from '../error/biz-error';
import { isDel, userConst } from '../const/entity-const';
import cryptoUtils from '../utils/crypto-utils';
import { allocateMailboxAddress } from './mailbox-address';
import userService from './user-service';

function assertEvent(event) {
	const required = ['event_id', 'event_type', 'employee_id', 'feishu_user_id', 'status'];
	if (!event || required.some(key => typeof event[key] !== 'string' || !event[key])) {
		throw new BizError('员工同步事件格式无效', 400);
	}
	if (!['ACTIVE', 'DISABLED'].includes(event.status)) {
		throw new BizError('员工同步状态无效', 400);
	}
}

async function findProcessedEvent(c, eventId) {
	return c.env.db.prepare(
		`SELECT result_json AS resultJson FROM identity_event WHERE event_id = ?`,
	).bind(eventId).first();
}

async function recordEvent(c, event, outcome) {
	await c.env.db.prepare(`
		INSERT OR IGNORE INTO identity_event (event_id, event_type, outcome, result_json)
		VALUES (?, ?, ?, ?)
	`).bind(event.event_id, event.event_type, outcome.status, JSON.stringify(outcome)).run();
}

async function findLink(c, event) {
	return c.env.db.prepare(`
		SELECT employee_id AS employeeId,
		       feishu_user_id AS feishuUserId,
		       keycloak_user_id AS keycloakUserId,
		       user_id AS userId,
		       mailbox_email AS mailboxEmail,
		       status
		FROM identity_link
		WHERE employee_id = ? OR feishu_user_id = ?
		LIMIT 1
	`).bind(event.employee_id, event.feishu_user_id).first();
}

async function saveLink(c, event, { userId = null, mailboxEmail = null, status }) {
	await c.env.db.prepare(`
		INSERT INTO identity_link (
			employee_id, feishu_user_id, keycloak_user_id, user_id, mailbox_email,
			status, name, source_email, last_event_id, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(feishu_user_id) DO UPDATE SET
			employee_id = excluded.employee_id,
			keycloak_user_id = excluded.keycloak_user_id,
			user_id = COALESCE(excluded.user_id, identity_link.user_id),
			mailbox_email = COALESCE(identity_link.mailbox_email, excluded.mailbox_email),
			status = excluded.status,
			name = excluded.name,
			source_email = excluded.source_email,
			last_event_id = excluded.last_event_id,
			updated_at = CURRENT_TIMESTAMP
	`).bind(
		event.employee_id,
		event.feishu_user_id,
		event.keycloak_user_id || null,
		userId,
		mailboxEmail,
		status,
		event.name || '',
		event.email || null,
		event.event_id,
	).run();
}

async function ensureUser(c, mailboxEmail) {
	let user = await userService.selectByEmailIncludeDel(c, mailboxEmail);
	if (user?.isDel === isDel.DELETE) {
		await userService.restore(c, { userId: user.userId });
		user = await userService.selectByEmailIncludeDel(c, mailboxEmail);
	}
	if (!user) {
		await userService.add(c, { email: mailboxEmail, password: cryptoUtils.genRandomPwd(32) });
		user = await userService.selectByEmailIncludeDel(c, mailboxEmail);
	}
	if (!user) throw new BizError('邮箱账户创建后无法读取', 500);
	if (user.status !== userConst.status.NORMAL) {
		await userService.setStatus(c, { userId: user.userId, status: userConst.status.NORMAL });
	}
	return user;
}

async function mailboxIsTaken(c, mailboxEmail) {
	const [user, link] = await Promise.all([
		userService.selectByEmailIncludeDel(c, mailboxEmail),
		c.env.db.prepare(`
			SELECT 1 AS mailboxTaken FROM identity_link WHERE mailbox_email = ? COLLATE NOCASE LIMIT 1
		`).bind(mailboxEmail).first(),
	]);
	return Boolean(user || link);
}

const identityService = {
	async reconcile(c, event) {
		assertEvent(event);
		const processed = await findProcessedEvent(c, event.event_id);
		if (processed) return JSON.parse(processed.resultJson);

		const link = await findLink(c, event);

		if (event.status === 'DISABLED' || event.event_type === 'employee.deactivated') {
			const user = link?.userId
				? await userService.selectByIdIncludeDel(c, link.userId)
				: link?.mailboxEmail
					? await userService.selectByEmailIncludeDel(c, link.mailboxEmail)
					: null;
			if (user && user.isDel !== isDel.DELETE) {
				await userService.setStatus(c, { userId: user.userId, status: userConst.status.BAN });
			}
			const outcome = { status: 'DISABLED', mailboxEmail: link?.mailboxEmail || null, userId: user?.userId || null };
			await saveLink(c, event, outcome);
			await recordEvent(c, event, outcome);
			return outcome;
		}

		const mailboxEmail = link?.mailboxEmail || await allocateMailboxAddress({
			name: event.name,
			domain: c.env.identity_mail_domain,
			isTaken: candidate => mailboxIsTaken(c, candidate),
		});

		if (!mailboxEmail) {
			const outcome = { status: 'PENDING_NAME', mailboxEmail: null };
			await saveLink(c, event, { status: outcome.status });
			await recordEvent(c, event, outcome);
			return outcome;
		}

		const user = await ensureUser(c, mailboxEmail);
		const outcome = { status: 'ACTIVE', mailboxEmail, userId: user.userId };
		await saveLink(c, event, outcome);
		await recordEvent(c, event, outcome);
		return outcome;
	},
};

export default identityService;
