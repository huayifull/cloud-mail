"""Grant mailbox creation to the SHEIN user's dedicated role."""
import json
import os
import runpy
from pathlib import Path

api = runpy.run_path(str(Path(__file__).with_name('provision-store-mailboxes.py')))['api']
account = os.environ['CLOUDFLARE_ACCOUNT_ID']
bindings = api(f'accounts/{account}/workers/scripts/cloud-mail/settings')['bindings']
database = next(b['id'] for b in bindings if b['type'] == 'd1' and b['name'] == 'db')


def query(sql, params=None):
    result = api(f'accounts/{account}/d1/database/{database}/query', {'sql': sql, 'params': params or []})
    assert all(r.get('success') for r in result), 'D1 query failed'
    return result[0]['results']


rows = query('''SELECT u.user_id,u.type,r.key,r.is_default,r.account_count,r.avail_domain
    FROM user u JOIN role r ON r.role_id=u.type
    WHERE u.email=? COLLATE NOCASE AND u.status=0 AND u.is_del=0''', ['shein@huayimail.com'])
assert len(rows) == 1 and rows[0]['key'] == 'shein-mailbox' and rows[0]['is_default'] == 0
owner = rows[0]
members = query('SELECT user_id FROM user WHERE type=?', [owner['type']])
assert members == [{'user_id': owner['user_id']}], 'Dedicated role is shared with other users'
permissions_before = query('SELECT role_id,perm_id FROM role_perm ORDER BY role_id,perm_id')
permission = query("SELECT perm_id FROM perm WHERE perm_key='account:add'")
assert len(permission) == 1
query('''INSERT INTO role_perm(role_id,perm_id) SELECT ?,?
    WHERE NOT EXISTS (SELECT 1 FROM role_perm WHERE role_id=? AND perm_id=?)''',
    [owner['type'], permission[0]['perm_id'], owner['type'], permission[0]['perm_id']])
permissions_after = query('SELECT role_id,perm_id FROM role_perm ORDER BY role_id,perm_id')
assert [p for p in permissions_before if p['role_id'] != owner['type']] == [
    p for p in permissions_after if p['role_id'] != owner['type']]
permissions = query('''SELECT p.perm_key FROM perm p JOIN role_perm rp ON p.perm_id=rp.perm_id
    WHERE rp.role_id=? AND coalesce(p.perm_key,'')<>'' ORDER BY p.perm_key''', [owner['type']])
assert any(p['perm_key'] == 'account:add' for p in permissions)
assert not any(p['perm_key'].startswith(('user:', 'role:', 'setting:', 'all-email:')) for p in permissions)
settings = query('SELECT add_email,many_email,add_email_verify,min_email_prefix FROM setting LIMIT 1')[0]
report = {'owner': 'shein@huayimail.com', 'creation_permission_granted': True,
          'permissions': permissions, 'mailbox_limit': owner['account_count'],
          'available_domain': owner['avail_domain'], 'settings': settings,
          'other_roles_unchanged': True}
Path('mailbox-creation-permission-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False))
