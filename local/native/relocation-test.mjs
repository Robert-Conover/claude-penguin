#!/usr/bin/env node
// Copies .local/runtimes to a path containing a space and runs every runtime
// from the copy, then scans the copy for paths that point back at the build.
//   node local/native/relocation-test.mjs [--runtimes DIR] [--keep]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const argv = process.argv.slice(2);
const source = path.resolve(argv.includes('--runtimes') ? argv[argv.indexOf('--runtimes') + 1] : path.join(repo, '.local/runtimes'));
const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cp reloc ')));
const copy = path.join(scratch, 'moved runtimes');
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`); if (!ok) failures++; };
const sh = (cmd, args, env = {}, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', env: { HOME: scratch, ...env }, maxBuffer: 1 << 26, ...opts });

console.log(`copying ${source} -> ${copy}`);
check('ditto copy', sh('ditto', [source, copy], { PATH: '/usr/bin:/bin' }).status === 0);

const R = name => path.join(copy, name);
const bare = { PATH: '/usr/bin:/bin' };
const run = (name, cmd, args, env = bare, expect) => {
  const r = sh(cmd, args, env);
  const text = `${r.stdout}${r.stderr}`.trim().split('\n')[0];
  check(name, r.status === 0 && (!expect || expect.test(`${r.stdout}${r.stderr}`)), text.slice(0, 110));
  return r;
};

run('node --version', R('node/bin/node'), ['--version'], bare, /^v24\./);
run('python --version', R('python/bin/python3'), ['--version'], bare, /3\.11/);
run('postgres --version', R('postgres/bin/postgres'), ['--version'], bare, /16\./);
for (const bin of ['initdb', 'pg_ctl', 'pg_isready', 'psql', 'pg_dump']) run(`${bin} --version`, R(`postgres/bin/${bin}`), ['--version'], bare, /16\./);
run('valkey-server --version', R('valkey/bin/valkey-server'), ['--version'], bare, /8\.1/);
run('valkey-cli --version', R('valkey/bin/valkey-cli'), ['--version'], bare, /8\.1/);
run('git --version', R('git/bin/git'), ['--version'], bare, /2\.56/);
const exec = run('git --exec-path', R('git/bin/git'), ['--exec-path']);
check('git exec-path is inside the copy', exec.stdout.trim().startsWith(copy), exec.stdout.trim());
const only = run('git-only/git (PATH has only that directory)', R('git-only/git'), ['--version'], { PATH: R('git-only') }, /2\.56/);
const onlyExec = sh('git', ['--exec-path'], { PATH: R('git-only') });
check('git-only exec-path is inside the copy', onlyExec.stdout.trim().startsWith(copy), onlyExec.stdout.trim());

// A real Git workflow with only git-only on PATH.
const repoDir = path.join(scratch, 'repo with space');
mkdirSync(repoDir);
const gitEnv = { PATH: R('git-only'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const init = sh('git', ['init', '-q', '-b', 'main', repoDir], gitEnv);
const flow = sh('/bin/sh', ['-c', 'echo hi > a.txt && git add a.txt && git commit -qm one && git worktree add -q ../wt && git -C ../wt log --oneline | /usr/bin/wc -l'], gitEnv, { cwd: repoDir });
check('git init/add/commit/worktree via git-only', init.status === 0 && flow.stdout.trim() === '1', `${init.stderr}${flow.stderr}`.trim().slice(0, 200));

// PostgreSQL: initdb finds share/ relative to the moved binary.
const pgData = path.join(scratch, 'pgdata');
run('initdb into a scratch directory', R('postgres/bin/initdb'), ['-D', pgData, '-A', 'trust', '-U', 'reloc', '--locale=C', '-E', 'UTF8'], bare, /Success/);

// Python: every service's packages import from the copy.
const imports = {
  houdini: ['asyncpg', 'bcrypt', 'gino', 'redis', 'cacheout', 'defusedxml', 'ujson', 'uvloop', 'pytz', 'sqlalchemy'],
  dash: ['sanic', 'sanic_session', 'PIL', 'PIL.Image', 'stegano', 'aiohttp', 'jinja2', 'yaml', 'i18n', 'fast_autocomplete', 'Levenshtein', 'bcrypt', 'gino', 'sendgrid', 'multidict', 'websockets', 'redis', 'asyncpg', 'httptools', 'uvloop'],
  snowflake: ['twisted', 'twisted.internet.reactor', 'psycopg', 'psycopg_binary', 'sqlalchemy', 'redis', 'dotenv', 'OpenSSL', 'service_identity', 'txwebsocket.txws'],
};
for (const [service, modules] of Object.entries(imports)) {
  const code = `import importlib,sys\nfor m in ${JSON.stringify(modules)}: importlib.import_module(m)\nimport redis,sqlalchemy\nprint(sys.prefix, redis.__version__, sqlalchemy.__version__)`;
  const r = run(`python imports (${service})`, R('python/bin/python3'), ['-s', '-c', code], { ...bare, PYTHONPATH: R(`envs/${service}`), PYTHONDONTWRITEBYTECODE: '1' });
  check(`${service} runs from the moved interpreter and env`, r.stdout.includes(copy), r.stdout.trim().slice(0, 100));
}

// Scan: no Mach-O dependency or rpath may reach outside the copy, and no file may embed the build locations.
const machO = sh('sh', ['-c', `find "${copy}" -type f \\( -perm -u+x -o -name '*.so' -o -name '*.dylib' \\) -print0 | xargs -0 file | grep -F Mach-O | cut -d: -f1`], bare).stdout.trim().split('\n').filter(Boolean);
const bad = [];
for (const file of machO) {
  const own = file.slice(copy.length);
  const deps = sh('otool', ['-L', file], bare).stdout.split('\n').filter(l => l.includes('(compatibility')).map(l => l.trim().split(' (compat')[0]);
  for (const dep of deps) if (/^\/(Users|opt|private|var|tmp)\//.test(dep)) bad.push(`${own}: ${dep}`);
  const rpaths = sh('sh', ['-c', `otool -l "${file}" | awk '/LC_RPATH/{r=1} r&&/path /{print $2; r=0}'`], bare).stdout.split('\n').filter(Boolean);
  for (const rp of rpaths) if (/^\/(Users|opt|private|var|tmp)\//.test(rp)) bad.push(`${own}: rpath ${rp}`);
}
check(`Mach-O dependencies and rpaths (${machO.length} files)`, bad.length === 0, bad.slice(0, 5).join('; '));
const forbidden = [repo, path.join(repo, '.local'), os.tmpdir(), '/private/tmp/claude'];
for (const needle of forbidden) {
  const hits = sh('grep', ['-rlaF', '--', needle, copy], bare).stdout.trim().split('\n').filter(Boolean);
  check(`no file embeds ${needle}`, hits.length === 0, hits.slice(0, 4).map(h => h.slice(copy.length)).join(', '));
}
const prefixHits = sh('grep', ['-rlaF', '--', '/opt/claude-penguin', copy], bare).stdout.trim().split('\n').filter(Boolean).map(h => h.slice(copy.length));
console.log(`INFO  compiled-in fallback prefix /opt/claude-penguin (never used for lookup) appears in: ${prefixHits.join(', ') || 'nothing'}`);

if (!argv.includes('--keep')) rmSync(scratch, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nrelocation test passed');
process.exit(failures ? 1 : 0);
