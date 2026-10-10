import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import accountService from './account-service';

describe('mailbox search', () => {
	let database;
	let context;

	beforeEach(() => {
		database = new DatabaseSync(':memory:');
		database.exec(`CREATE TABLE account (
			account_id INTEGER PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
			status INTEGER DEFAULT 0, latest_email_time TEXT, create_time TEXT,
			user_id INTEGER NOT NULL, all_receive INTEGER DEFAULT 0,
			sort INTEGER DEFAULT 0, is_del INTEGER DEFAULT 0
		)`);
		// Execute Drizzle's generated query against SQLite using D1's raw result format.
		context = { env: { db: { prepare(query) {
			const statement = database.prepare(query);
			statement.setReturnArrays(true);
			return { bind(...values) { return { async raw() { return statement.all(...values); } }; } };
		} } } };
		const insert = database.prepare('INSERT INTO account(account_id,email,name,user_id,sort) VALUES (?,?,?,?,?)');
		insert.run(1, 'admin@huayimail.com', 'admin', 1, 100);
		for (let id = 2; id <= 46; id++) {
			insert.run(id, `${1000000000 + id}@huayimail.com`, `华易店铺 ${id}`, 1, 0);
		}
		insert.run(47, 'other@huayimail.com', '华易店铺 其他用户', 2, 0);
		insert.run(48, 'deleted@huayimail.com', '华易店铺 已删除', 1, 0);
		database.exec('UPDATE account SET is_del=1 WHERE account_id=48');
	});

	afterEach(() => database.close());

	it('finds an address beyond the first page and matches partial store IDs', async () => {
		const first = await accountService.list(context, { size: 30 }, 1);
		expect(first).toHaveLength(30);
		expect(first.some(item => item.accountId === 46)).toBe(false);
		const result = await accountService.list(context, { keyword: '0046', size: 30 }, 1);
		expect(result.map(item => item.email)).toEqual(['1000000046@huayimail.com']);
	});

	it('matches names and email substrings regardless of ASCII case', async () => {
		expect((await accountService.list(context, { keyword: '  ADMIN@HUAYIMAIL.COM  ' }, 1))
			.map(item => item.accountId)).toEqual([1]);
		expect((await accountService.list(context, { keyword: '店铺 46' }, 1))
			.map(item => item.accountId)).toEqual([46]);
	});

	it('keeps owner and deletion restrictions for every search', async () => {
		const results = await accountService.list(context, { keyword: '华易店铺', size: 30 }, 1);
		expect(results.every(item => item.userId === 1 && item.isDel === 0)).toBe(true);
		expect(await accountService.list(context, { keyword: 'other' }, 1)).toEqual([]);
		expect(await accountService.list(context, { keyword: 'deleted' }, 1)).toEqual([]);
	});

	it('continues filtered pagination in sort order without duplicates or missing rows', async () => {
		database.exec('UPDATE account SET sort=50 WHERE account_id=46');
		const first = await accountService.list(context, { keyword: '华易店铺', size: 30 }, 1);
		expect(first[0].accountId).toBe(46);
		const last = first.at(-1);
		const second = await accountService.list(context, {
			keyword: '华易店铺', size: 30, accountId: last.accountId, lastSort: last.sort
		}, 1);
		const ids = [...first, ...second].map(item => item.accountId);
		expect(ids).toHaveLength(45);
		expect(new Set(ids).size).toBe(45);
		expect(ids).toEqual([46, ...Array.from({ length: 44 }, (_, index) => index + 2)]);
	});

	it('treats wildcard characters literally and keeps query values bound', async () => {
		const name = "折扣 50%_\\' OR 1=1 --";
		database.prepare('UPDATE account SET name=? WHERE account_id=46').run(name);
		for (const keyword of ['%', '_', '\\', "' OR 1=1 --", name]) {
			expect((await accountService.list(context, { keyword }, 1))
				.map(item => item.accountId)).toEqual([46]);
		}
		expect(await accountService.list(context, { keyword: 'no-such-mailbox' }, 1)).toEqual([]);
	});

	it('restores the unfiltered first page after clearing the keyword', async () => {
		expect(await accountService.list(context, { keyword: '  ', size: 30, lastSort: null }, 1))
			.toEqual(await accountService.list(context, { size: 30 }, 1));
	});
});
