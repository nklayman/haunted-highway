// Publish web/ to the gh-pages branch with cache-busted imports.
// GitHub Pages caches files for 10 minutes, so a new page can load stale modules;
// stamping every relative .js reference with the commit hash keeps a deploy consistent.
//   node scripts/deploy.mjs          build + commit to gh-pages (local only)
//   node scripts/deploy.mjs --push   also push to origin
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sh = (cmd, env = {}) => execSync(cmd, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' }).trim();

if (sh('git status --porcelain -- web')) throw new Error('web/ has uncommitted changes; commit first');
const version = sh('git rev-parse --short HEAD');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'racewheel-deploy-'));
fs.cpSync(path.join(root, 'web'), out, { recursive: true });

// from './x.js' · import('./x.js') · src="x.js"  →  same with ?v=<version>
const stamp = (text) => text
  .replace(/((?:from|import)\s*\(?\s*)(['"])(\.\/[^'"?]+\.js)\2/g, `$1$2$3?v=${version}$2`)
  .replace(/(<script[^>]*\bsrc=)(['"])((?!https?:)[^'"?]+\.js)\2/g, `$1$2$3?v=${version}$2`);
for (const f of fs.readdirSync(out)) {
  if (!/\.(js|html)$/.test(f)) continue;
  const p = path.join(out, f);
  fs.writeFileSync(p, stamp(fs.readFileSync(p, 'utf8')));
}

// Commit the build onto gh-pages without touching the working tree.
const index = path.join(out, '..', `racewheel-index-${version}`);
const env = { GIT_DIR: path.join(root, '.git'), GIT_INDEX_FILE: index, GIT_WORK_TREE: out };
execSync('git add --all .', { cwd: out, env: { ...process.env, ...env } });
const tree = sh('git write-tree', env);
fs.rmSync(index, { force: true });
const parent = sh('git rev-parse --verify --quiet gh-pages || true');
const commit = sh(`git commit-tree ${tree} ${parent ? `-p ${parent}` : ''} -m "Deploy ${version}"`);
sh(`git update-ref refs/heads/gh-pages ${commit}`);
fs.rmSync(out, { recursive: true, force: true });
console.log(`gh-pages -> ${commit.slice(0, 7)} (web/ @ ${version})`);

if (process.argv.includes('--push')) {
  sh('git push origin gh-pages');
  console.log('pushed');
}
