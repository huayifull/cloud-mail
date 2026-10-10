"""Move an explicit SHEIN inbox manifest and its messages to a dedicated user."""
import base64
import hashlib
import hmac
import json
import os
import re
import runpy
import secrets
import time
import urllib.request
from pathlib import Path


OWNER = 'shein@huayimail.com'
ROLE_KEY = 'shein-mailbox'
PERM_IDS = [1, 2, 4, 21, 22, 23]


def migration_statements(items, source, owner_email, password):
    """D1 batch: create the ordinary user, then transfer all related ownership."""
    payload = json.dumps(items)
    salt = base64.b64encode(secrets.token_bytes(16)).decode()
    password_hash = base64.b64encode(hashlib.sha256((salt + password).encode()).digest()).decode()
    owner = '(SELECT user_id FROM user WHERE email=? COLLATE NOCASE AND status=0 AND is_del=0)'
    ids = "SELECT json_extract(value,'$.account_id') FROM json_each(?)"
    statements = [
        ('''INSERT INTO role(name,key,description,user_id,is_default,send_type,account_count,avail_domain)
            SELECT 'SHEIN 店铺邮箱',?,'管理 SHEIN 店铺收件箱',?,0,'ban',10000,'huayimail.com'
            WHERE NOT EXISTS (SELECT 1 FROM role WHERE key=?)''', [ROLE_KEY, source, ROLE_KEY]),
        ('''INSERT INTO role_perm(role_id,perm_id)
            SELECT r.role_id,p.perm_id FROM role r CROSS JOIN perm p
            WHERE r.key=? AND p.perm_id IN (SELECT value FROM json_each(?))
            AND NOT EXISTS (SELECT 1 FROM role_perm rp WHERE rp.role_id=r.role_id AND rp.perm_id=p.perm_id)''',
         [ROLE_KEY, json.dumps(PERM_IDS)]),
        ('''INSERT INTO user(email,password,salt,type)
            SELECT ?,?,?,(SELECT role_id FROM role WHERE key=?)
            WHERE NOT EXISTS (SELECT 1 FROM user WHERE email=? COLLATE NOCASE)''',
         [owner_email, password_hash, salt, ROLE_KEY, owner_email]),
        (f'''INSERT INTO account(email,name,user_id,sort)
            SELECT ?,'SHEIN 店铺邮箱',{owner},100000
            WHERE NOT EXISTS (SELECT 1 FROM account WHERE email=? COLLATE NOCASE)''',
         [owner_email, owner_email, owner_email]),
        (f'''UPDATE account SET user_id={owner}
            WHERE account_id IN ({ids}) AND user_id=?
            AND EXISTS (SELECT 1 FROM json_each(?) requested
                WHERE json_extract(requested.value,'$.account_id')=account.account_id
                AND json_extract(requested.value,'$.email')=account.email COLLATE NOCASE)''',
         [owner_email, payload, source, payload]),
    ]
    # Include deleted/draft messages and attachments; preserve all IDs and content.
    for table in ['email', 'attachments']:
        statements.append((f'''UPDATE {table} SET user_id={owner}
            WHERE account_id IN ({ids}) AND user_id=?
            AND account_id IN (SELECT account_id FROM account WHERE user_id={owner})''',
                           [owner_email, payload, source, owner_email]))
    statements.append((f'''UPDATE star SET user_id={owner}
        WHERE user_id=? AND email_id IN (SELECT email_id FROM email
            WHERE account_id IN ({ids}) AND user_id={owner})''',
                       [owner_email, source, payload, owner_email]))
    return [{'sql': sql, 'params': params} for sql, params in statements]


def main():
    api = runpy.run_path(str(Path(__file__).with_name('provision-store-mailboxes.py')))['api']
    items = json.loads(os.environ['MAILBOXES_JSON'])
    assert isinstance(items, list) and 0 < len(items) <= 100
    assert len({i['account_id'] for i in items}) == len(items)
    assert len({i['email'].lower() for i in items}) == len(items)
    assert all(isinstance(i['account_id'], int) and i['account_id'] > 0 and
               re.fullmatch(r'[0-9]{1,20}@huayimail\.com', i['email']) for i in items)
    owner_email = os.environ.get('STORE_MAILBOX_OWNER') or OWNER
    assert owner_email == OWNER and owner_email.lower() != os.environ['ADMIN'].lower()
    account = os.environ['CLOUDFLARE_ACCOUNT_ID']
    bindings = api(f'accounts/{account}/workers/scripts/cloud-mail/settings')['bindings']
    database = next(b['id'] for b in bindings if b['type'] == 'd1' and b['name'] == 'db')
    endpoint = f'accounts/{account}/d1/database/{database}/query'

    def query(sql, params=None):
        result = api(endpoint, {'sql': sql, 'params': params or []})
        assert all(r.get('success') for r in result), 'D1 query failed'
        return result[0]['results']

    admins = query('SELECT user_id,status,is_del FROM user WHERE email=? COLLATE NOCASE', [os.environ['ADMIN']])
    assert len(admins) == 1 and admins[0]['status'] == 0 and admins[0]['is_del'] == 0
    source = admins[0]['user_id']
    owners = query('SELECT user_id,status,is_del,type FROM user WHERE email=? COLLATE NOCASE', [owner_email])
    assert len(owners) <= 1 and all(o['status'] == 0 and o['is_del'] == 0 for o in owners)
    allowed_owners = {source} | {o['user_id'] for o in owners}
    ids = json.dumps([i['account_id'] for i in items])
    select = 'SELECT account_id,email,name,user_id,status,is_del FROM account WHERE account_id IN (SELECT value FROM json_each(?)) ORDER BY account_id'
    before = query(select, [ids])
    assert {r['account_id']: r['email'] for r in before} == {i['account_id']: i['email'] for i in items}
    assert all(r['user_id'] in allowed_owners and r['status'] == 0 and r['is_del'] == 0 for r in before)
    main_inboxes = query('SELECT user_id,status,is_del FROM account WHERE email=? COLLATE NOCASE', [owner_email])
    assert not main_inboxes or (owners and len(main_inboxes) == 1 and
        main_inboxes[0]['user_id'] == owners[0]['user_id'] and main_inboxes[0]['status'] == 0 and main_inboxes[0]['is_del'] == 0)
    roles = query('SELECT role_id FROM role WHERE key=?', [ROLE_KEY])
    assert len(roles) <= 1
    if owners:
        assert roles and owners[0]['type'] == roles[0]['role_id'], 'Dedicated user role conflict'
    if roles:
        perms = query('SELECT perm_id FROM role_perm WHERE role_id=?', [roles[0]['role_id']])
        assert {p['perm_id'] for p in perms} <= set(PERM_IDS), 'Dedicated role has unexpected permissions'
    assert query('SELECT receive FROM setting LIMIT 1')[0]['receive'] == 0
    unrelated = query('SELECT account_id,email,name,user_id,status,is_del FROM account WHERE account_id NOT IN (SELECT value FROM json_each(?)) ORDER BY account_id', [ids])
    original_messages = query('SELECT email_id,account_id,user_id FROM email WHERE account_id IN (SELECT value FROM json_each(?))', [ids])
    original_attachments = query('SELECT att_id,account_id,user_id FROM attachments WHERE account_id IN (SELECT value FROM json_each(?))', [ids])
    assert all(r['user_id'] in allowed_owners for r in original_messages + original_attachments)
    apply = os.environ.get('APPLY') == 'true'
    if apply:
        password = os.environ['SHEIN_MAILBOX_PASSWORD']
        assert 16 <= len(password) <= 30
        statements = migration_statements(items, source, owner_email, password)
        result = api(endpoint, {'batch': statements})
        assert len(result) == len(statements) and all(r.get('success') for r in result), 'Migration batch failed'
    verified = query(select, [ids])
    report = {'applied': apply, 'owner': owner_email, 'requested': len(items),
              'messages': len(original_messages), 'attachments': len(original_attachments),
              'mailboxes': verified}
    if apply:
        owner = query('SELECT user_id FROM user WHERE email=? COLLATE NOCASE', [owner_email])[0]['user_id']
        assert len(verified) == len(items) and all(r['user_id'] == owner for r in verified)
        assert {(r['account_id'], r['email'], r['name'], r['status'], r['is_del']) for r in before} == {
            (r['account_id'], r['email'], r['name'], r['status'], r['is_del']) for r in verified}
        for table, id_field, original in [('email', 'email_id', original_messages), ('attachments', 'att_id', original_attachments)]:
            rows = query(f'SELECT {id_field},account_id,user_id FROM {table} WHERE account_id IN (SELECT value FROM json_each(?))', [ids])
            assert all(r['user_id'] == owner for r in rows)
            assert {r[id_field] for r in original} <= {r[id_field] for r in rows}
        after_unrelated = query('SELECT account_id,email,name,user_id,status,is_del FROM account WHERE account_id NOT IN (SELECT value FROM json_each(?)) AND email<>? COLLATE NOCASE ORDER BY account_id', [ids, owner_email])
        assert [r for r in unrelated if r['email'].lower() != owner_email] == after_unrelated
        report['verified'] = len(verified)
        report['unrelated_inboxes_unchanged'] = True
    if os.environ.get('VERIFY_PROVISION') == 'true':
        mailbox = verified[0]
        body = json.dumps({'store_id': mailbox['email'].split('@')[0], 'name': mailbox['name']}).encode()
        timestamp = str(int(time.time()))
        signature = hmac.new(os.environ['STORE_MAILBOX_SECRET'].encode(), timestamp.encode() + b'.' + body, hashlib.sha256).hexdigest()
        request = urllib.request.Request('https://mail.huayimail.com/api/internal/store-mailboxes', data=body,
            headers={'Content-Type': 'application/json', 'X-Store-Timestamp': timestamp, 'X-Store-Signature': signature,
                     'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
        assert result['data']['account_id'] == mailbox['account_id'] and result['data']['email'] == mailbox['email']
        assert result['data']['status'] == 'READY'
        report['automatic_provisioning_owner_verified'] = True
    Path('mailbox-owner-migration-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'mailboxes'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
