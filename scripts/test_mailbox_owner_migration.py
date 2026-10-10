import base64
import hashlib
import runpy
import sqlite3
import unittest
from pathlib import Path

migration_statements = runpy.run_path(str(Path(__file__).with_name('migrate-store-mailbox-owner.py')))['migration_statements']


class MailboxOwnerMigrationTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.executescript('''
            CREATE TABLE role(role_id INTEGER PRIMARY KEY,name TEXT,key TEXT,description TEXT,user_id INTEGER,
                is_default INTEGER,send_type TEXT,account_count INTEGER,avail_domain TEXT);
            CREATE TABLE perm(perm_id INTEGER PRIMARY KEY);
            INSERT INTO perm VALUES (1),(2),(4),(21),(22),(23),(7),(28);
            CREATE TABLE role_perm(role_id INTEGER,perm_id INTEGER);
            CREATE TABLE user(user_id INTEGER PRIMARY KEY,email TEXT UNIQUE,password TEXT,salt TEXT,type INTEGER,
                status INTEGER DEFAULT 0,is_del INTEGER DEFAULT 0);
            INSERT INTO user VALUES (1,'admin@huayimail.com','original-hash','original-salt',1,0,0);
            CREATE TABLE account(account_id INTEGER PRIMARY KEY,email TEXT UNIQUE,name TEXT,user_id INTEGER,
                sort INTEGER DEFAULT 0,status INTEGER DEFAULT 0,is_del INTEGER DEFAULT 0);
            INSERT INTO account(account_id,email,name,user_id) VALUES
                (1,'admin@huayimail.com','admin',1),
                (58,'123@huayimail.com','SHEIN 店铺',1),
                (59,'amazon@huayimail.com','另一平台',1);
            CREATE TABLE email(email_id INTEGER PRIMARY KEY,account_id INTEGER,user_id INTEGER,content TEXT,is_del INTEGER);
            INSERT INTO email VALUES (1,58,1,'history',0),(2,58,1,'deleted draft',1),(3,59,1,'unrelated',0);
            CREATE TABLE attachments(att_id INTEGER PRIMARY KEY,account_id INTEGER,user_id INTEGER,key TEXT);
            INSERT INTO attachments VALUES (1,58,1,'existing-object-key'),(2,59,1,'other-object-key');
            CREATE TABLE star(star_id INTEGER PRIMARY KEY,email_id INTEGER,user_id INTEGER);
            INSERT INTO star VALUES (1,1,1),(2,3,1);
        ''')
        self.items = [{'account_id': 58, 'email': '123@huayimail.com'}]
        self.password = 'test-password-123456'

    def batch(self, statements):
        with self.db:
            for statement in statements:
                self.db.execute(statement['sql'], statement['params'])

    def test_transfers_history_and_preserves_other_platform_and_credentials(self):
        self.batch(migration_statements(self.items, 1, 'shein@huayimail.com', self.password))
        owner, stored_hash, salt = self.db.execute("SELECT user_id,password,salt FROM user WHERE email='shein@huayimail.com'").fetchone()
        self.assertNotEqual(owner, 1)
        expected = base64.b64encode(hashlib.sha256((salt + self.password).encode()).digest()).decode()
        self.assertEqual(stored_hash, expected)
        self.assertEqual(self.db.execute('SELECT account_id,email,name,user_id FROM account WHERE account_id=58').fetchone(),
                         (58, '123@huayimail.com', 'SHEIN 店铺', owner))
        self.assertEqual(self.db.execute('SELECT user_id,content,is_del FROM email WHERE account_id=58').fetchall(),
                         [(owner, 'history', 0), (owner, 'deleted draft', 1)])
        self.assertEqual(self.db.execute('SELECT user_id,key FROM attachments WHERE att_id=1').fetchone(), (owner, 'existing-object-key'))
        self.assertEqual(self.db.execute('SELECT user_id FROM star WHERE star_id=1').fetchone(), (owner,))
        self.assertEqual(self.db.execute('SELECT user_id,content FROM email WHERE email_id=3').fetchone(), (1, 'unrelated'))
        self.assertEqual(self.db.execute('SELECT user_id FROM account WHERE account_id IN (1,59)').fetchall(), [(1,), (1,)])
        self.assertEqual(self.db.execute('SELECT password,salt FROM user WHERE user_id=1').fetchone(), ('original-hash', 'original-salt'))
        self.assertEqual(self.db.execute('SELECT perm_id FROM role_perm ORDER BY perm_id').fetchall(), [(1,), (2,), (4,), (21,), (22,), (23,)])
        # A retry must preserve the existing password, IDs and all messages.
        self.batch(migration_statements(self.items, 1, 'shein@huayimail.com', 'a-different-password-123'))
        self.assertEqual(self.db.execute("SELECT password FROM user WHERE email='shein@huayimail.com'").fetchone(), (stored_hash,))
        self.assertEqual(self.db.execute('SELECT count(*) FROM account').fetchone(), (4,))
        self.assertEqual(self.db.execute('SELECT count(*) FROM email').fetchone(), (3,))

    def test_rejects_batch_as_a_unit_when_a_write_fails(self):
        self.db.execute("CREATE TRIGGER reject_transfer BEFORE UPDATE OF user_id ON account BEGIN SELECT RAISE(ABORT,'blocked'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.batch(migration_statements(self.items, 1, 'shein@huayimail.com', self.password))
        self.assertEqual(self.db.execute('SELECT count(*) FROM user').fetchone(), (1,))
        self.assertEqual(self.db.execute('SELECT user_id FROM account WHERE account_id=58').fetchone(), (1,))


if __name__ == '__main__':
    unittest.main()
