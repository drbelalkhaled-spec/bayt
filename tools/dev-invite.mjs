// Make a join link for a test account on the LOCAL dev database (never the live one).
// Run: npm run dev:invite -- nanny TestHelper     (role: parent | nanny)
// Needs MAX_MEMBERS in .dev.vars above the real household size, and `npm run dev` running.
// Open the link on a different origin per account (localhost vs 127.0.0.1) so their logins don't clash.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));

const [role = 'nanny', name = role === 'parent' ? 'TestParent' : 'TestHelper'] = process.argv.slice(2);
if (role !== 'parent' && role !== 'nanny') throw new Error('role must be parent or nanny');
if (!/^[\w ]{1,40}$/.test(name)) throw new Error('name: letters, digits, spaces (max 40)');

const d1 = (sql) =>
  JSON.parse(
    execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'bayt', '--local', '--json', '--command', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
  )[0].results;

const [parent] = d1("SELECT id FROM members WHERE role = 'parent' AND removed_at IS NULL LIMIT 1");
if (!parent) throw new Error('No parent in the local household yet: run the app once and set it up first');

const secret = randomBytes(16).toString('hex');
const hash = createHash('sha256').update(secret).digest('hex');
const t = Date.now();
d1(
  `INSERT INTO invites(id, secret_hash, role, name, created_by, created_at, expires_at)
   VALUES('${randomUUID()}', '${hash}', '${role}', '${name}', '${parent.id}', ${t}, ${t + 86_400_000})`,
);
console.log(`${role} invite for ${name} (valid 24h):`);
console.log(`  http://localhost:8787/#join=${secret}`);
console.log(`  http://127.0.0.1:8787/#join=${secret}`);
