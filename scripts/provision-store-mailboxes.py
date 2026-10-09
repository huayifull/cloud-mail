"""Provision explicitly supplied store inboxes under the existing administrator."""
import json
import os
import re
import urllib.request
from pathlib import Path


def api(path, body=None):
    request = urllib.request.Request(
        'https://api.cloudflare.com/client/v4/' + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'],
                 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        data = json.load(response)
    if not data.get('success'):
        raise RuntimeError('Cloudflare request failed: ' + path)
    return data['result']


def main():
    items = json.loads(os.environ['MAILBOXES_JSON'])
    assert isinstance(items, list) and 0 < len(items) <= 100
    for item in items:
        assert re.fullmatch(r'shein\.[0-9]+@huayimail\.com', item['email'])
        assert isinstance(item['name'], str) and 0 < len(item['name']) <= 100
    assert len({i['email'] for i in items}) == len(items)
    account = os.environ['CLOUDFLARE_ACCOUNT_ID']
    bindings = api(f'accounts/{account}/workers/scripts/cloud-mail/settings')['bindings']
    dbs = [b for b in bindings if b['type'] == 'd1' and b['name'] == 'db']
    assert len(dbs) == 1
    database = dbs[0]['id']
    domains = next((b.get('json', b.get('text')) for b in bindings if b['name'] == 'domain'), None)
    if isinstance(domains, str):
        domains = json.loads(domains)
    assert 'huayimail.com' in domains
    admin = os.environ['ADMIN']

    def query(sql, params=None):
        result = api(f'accounts/{account}/d1/database/{database}/query',
                     {'sql': sql, 'params': params or []})
        assert all(r.get('success') for r in result), 'D1 query failed'
        return result[0]['results']

    users = query('SELECT user_id,status,is_del FROM user WHERE email=? COLLATE NOCASE', [admin])
    assert len(users) == 1 and users[0]['status'] == 0 and users[0]['is_del'] == 0
    owner = users[0]['user_id']
    settings = query('SELECT receive FROM setting LIMIT 1')
    assert len(settings) == 1 and settings[0]['receive'] == 0, 'Receiving is disabled'
    payload = json.dumps(items, ensure_ascii=False)
    select = '''SELECT account_id,email,name,user_id,status,is_del FROM account
        WHERE lower(email) IN (SELECT lower(json_extract(value,'$.email')) FROM json_each(?))'''
    existing = query(select, [payload])
    assert len({r['email'].lower() for r in existing}) == len(existing)
    assert all(r['user_id'] == owner and r['status'] == 0 and r['is_del'] == 0
               for r in existing), 'Existing inbox ownership/status conflict'
    apply = os.environ.get('APPLY') == 'true'
    if apply:
        query('''INSERT INTO account(email,name,user_id)
            SELECT json_extract(value,'$.email'),json_extract(value,'$.name'),?
            FROM json_each(?) AS requested
            WHERE NOT EXISTS (SELECT 1 FROM account
                WHERE email=json_extract(requested.value,'$.email') COLLATE NOCASE)''',
              [owner, payload])
    verified = query(select, [payload])
    if apply:
        assert len(verified) == len(items)
        assert all(r['user_id'] == owner and r['status'] == 0 and r['is_del'] == 0 for r in verified)
    report = {'applied': apply, 'requested': len(items), 'existing': len(existing),
              'verified': len(verified), 'receiving_enabled': True,
              'mailboxes': [{'email': r['email'], 'name': r['name'], 'account_id': r['account_id']}
                            for r in verified]}
    # Routing readback is optional: the deployment token may not have zone read scope.
    try:
        zones = api('zones?name=huayimail.com')
        assert len(zones) == 1
        zone = zones[0]['id']
        catchall = api(f'zones/{zone}/email/routing/rules/catch_all')
        report['catch_all_to_cloud_mail'] = bool(catchall.get('enabled')) and any(
            a.get('type') == 'worker' and 'cloud-mail' in a.get('value', [])
            for a in catchall.get('actions', []))
    except Exception:
        report['catch_all_to_cloud_mail'] = 'unverified'
    Path('mailbox-provision-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'mailboxes'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
