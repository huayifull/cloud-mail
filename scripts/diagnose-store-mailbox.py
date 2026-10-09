"""Read inbox delivery metadata without exporting message bodies or credentials."""
import json
import os
import runpy
import urllib.error
from pathlib import Path

api = runpy.run_path(str(Path(__file__).with_name('provision-store-mailboxes.py')))['api']
address = os.environ['MAILBOX_ADDRESS']
assert address == '3996121255@huayimail.com'
account = os.environ['CLOUDFLARE_ACCOUNT_ID']
bindings = api(f'accounts/{account}/workers/scripts/cloud-mail/settings')['bindings']
database = next(b['id'] for b in bindings if b['type'] == 'd1' and b['name'] == 'db')
def query(sql, params=None):
    result = api(f'accounts/{account}/d1/database/{database}/query', {'sql': sql, 'params': params or []})
    assert all(r.get('success') for r in result)
    return result[0]['results']
report = {}
report['account'] = query('SELECT a.account_id,a.email,a.name,a.status,a.is_del,a.latest_email_time,a.user_id,u.status AS owner_status,u.is_del AS owner_deleted,(u.email=?) AS is_admin FROM account a JOIN user u ON u.user_id=a.user_id WHERE a.email=? COLLATE NOCASE', [os.environ['ADMIN'],address])
report['messages'] = query('SELECT email_id,account_id,user_id,to_email,status,is_del,unread,create_time FROM email WHERE to_email=? COLLATE NOCASE OR account_id IN (SELECT account_id FROM account WHERE email=? COLLATE NOCASE) ORDER BY email_id DESC LIMIT 10',[address,address])
report['settings'] = query('SELECT receive,no_recipient FROM setting LIMIT 1')
report['test_matches'] = query("SELECT email_id,create_time,status,is_del FROM email WHERE to_email=? AND send_email=? AND coalesce(subject,'')='' AND trim(text)=? ORDER BY email_id DESC LIMIT 10", [address,'2272346895@qq.com','hi'])
try:
    zones = api('zones?name=huayimail.com')
    assert len(zones) == 1
    zone = zones[0]['id']
    report['routing'] = api(f'zones/{zone}/email/routing')
    report['catch_all'] = api(f'zones/{zone}/email/routing/rules/catch_all')
except urllib.error.HTTPError as error:
    report['routing_error'] = {'status':error.code}
except Exception as error:
    report['routing_error'] = type(error).__name__
Path('mailbox-diagnostics.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print('Mailbox diagnostic report saved')
