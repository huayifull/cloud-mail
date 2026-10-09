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
});
