"""Rename managed store inboxes without changing account IDs or messages."""
import json
import os
import re
from pathlib import Path
import runpy
api = runpy.run_path(str(Path(__file__).with_name('provision-store-mailboxes.py')))['api']


account = os.environ['CLOUDFLARE_ACCOUNT_ID']
bindings = api(f'accounts/{account}/workers/scripts/cloud-mail/settings')['bindings']
database = next(b['id'] for b in bindings if b['type'] == 'd1' and b['name'] == 'db')


def query(sql, params=None):
    result = api(f'accounts/{account}/d1/database/{database}/query', {'sql': sql, 'params': params or []})
    assert all(r.get('success') for r in result)
    return result[0]['results']


owners = query('SELECT user_id FROM user WHERE email=? COLLATE NOCASE AND status=0 AND is_del=0', [os.environ['ADMIN']])
assert len(owners) == 1
owner = owners[0]['user_id']
rows = query('SELECT account_id,email,user_id FROM account WHERE email LIKE ?', ['shein.%@huayimail.com'])
rows = [r for r in rows if re.fullmatch(r'shein\.[0-9]+@huayimail\.com', r['email'])]
assert all(r['user_id'] == owner for r in rows), 'Ownership conflict'
ids = json.dumps([r['account_id'] for r in rows])
# One SQL statement: uniqueness conflicts roll back the whole statement.
query('UPDATE account SET email=substr(email,7) WHERE account_id IN (SELECT value FROM json_each(?)) AND user_id=? AND email LIKE ?',
      [ids, owner, 'shein.%@huayimail.com'])
verified = query('SELECT account_id,email FROM account WHERE account_id IN (SELECT value FROM json_each(?))', [ids])
assert {r['account_id']: r['email'] for r in verified} == {r['account_id']: r['email'][6:] for r in rows}
Path('mailbox-rename-result.json').write_text(json.dumps({'renamed': len(verified), 'mailboxes': verified}, indent=2))
print(json.dumps({'renamed': len(verified)}))
