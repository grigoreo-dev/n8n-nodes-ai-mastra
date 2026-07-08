import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(homedir(), '.n8n', 'custom', 'node_modules', 'n8n-nodes-ai-mastra');
const distLink = join(target, 'dist');
const distTarget = join(repoRoot, 'dist');

mkdirSync(target, { recursive: true });
cpSync(join(repoRoot, 'package.json'), join(target, 'package.json'));

if (existsSync(distLink)) {
	const stat = lstatSync(distLink);
	if (stat.isSymbolicLink() && resolve(dirname(distLink), readlinkSync(distLink)) === distTarget) {
		console.log('Custom node path already set:', target);
		process.exit(0);
	}
	rmSync(distLink, { recursive: true, force: true });
}

symlinkSync(distTarget, distLink);
console.log('Installed custom node stub (no node_modules next to nodes):');
console.log(' ', target);
console.log(' dist ->', distTarget);
console.log('Run: npm run dev');
