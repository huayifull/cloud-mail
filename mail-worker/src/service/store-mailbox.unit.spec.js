import { describe, expect, it } from 'vitest';
import { storeMailboxInput, provisionStoreMailbox } from './store-mailbox-service';

describe('store mailboxes', () => {
	it('uses the platform store ID verbatim, not merchant identity', () => {
		expect(storeMailboxInput({store_id: '8245046553', name: '跨点'}, ['huayimail.com']).email)
			.toBe('8245046553@huayimail.com');
		for (const id of ['', 'E123', '1@evil.com', ' 123', '１２３']) {
			expect(() => storeMailboxInput({store_id:id,name:'店铺'}, ['huayimail.com'])).toThrow();
		}
	});
	it('does not claim another owner or disabled mailbox', async () => {
		const db = { prepare(sql) { return {bind(){return this;}, async run(){}, async first(){
			if (sql.includes('FROM user')) return {user_id:1,status:0,is_del:0};
			if (sql.includes('FROM setting')) return {receive:0};
			return {account_id:5,email:'123@huayimail.com',user_id:2,status:0,is_del:0};
		}};}};
		await expect(provisionStoreMailbox({env:{db,domain:['huayimail.com'],admin:'admin@huayimail.com'}},
			{store_id:'123',name:'店铺'})).rejects.toThrow('冲突');
	});
	it('selects the dedicated user even when an administrator exists', async () => {
		let selectedEmail;
		const db = { prepare(sql) { return {bind(...params){if(sql.includes('FROM user')) selectedEmail=params[0];return this;}, async run(){}, async first(){
			if (sql.includes('FROM user')) return {user_id:2,status:0,is_del:0};
			if (sql.includes('FROM setting')) return {receive:0};
			return {account_id:5,email:'123@huayimail.com',user_id:2,status:0,is_del:0};
		}};}};
		await provisionStoreMailbox({env:{db,domain:['huayimail.com'],admin:'admin@huayimail.com'}}, {store_id:'123',name:'店铺'});
		expect(selectedEmail).toBe('shein@huayimail.com');
	});
	it('refuses the administrator as the configured owner', async () => {
		await expect(provisionStoreMailbox({env:{domain:['huayimail.com'],admin:'Admin@huayimail.com',store_mailbox_owner:'admin@huayimail.com'}},
			{store_id:'123',name:'店铺'})).rejects.toThrow('专用用户');
	});
	it.each([null, {user_id:2,status:1,is_del:0}, {user_id:2,status:0,is_del:1}])('never falls back when the dedicated user is unavailable: %j', async (owner) => {
		const db = { prepare() { return {bind(){return this;}, async first(){return owner;}};}};
		await expect(provisionStoreMailbox({env:{db,domain:['huayimail.com'],admin:'admin@huayimail.com'}},
			{store_id:'123',name:'店铺'})).rejects.toThrow('专用用户不可用');
	});
});
