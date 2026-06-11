#!/usr/bin/env node
// Regenerate the Scoop manifest (scoop-yaw/bucket/<pkg>.json) and Homebrew
// formula (homebrew-yaw/Formula/<cmd>.rb) for a published release, filling in
// the version + per-arch sha256s from the GitHub Release's `.sha256` sidecars.
//
// Everything repo-specific is DERIVED from package.json (command name, repo
// slug, license, description), so this script is copy-paste across @yawlabs/*
// servers -- only the sibling-repo dirs are flags. Mirrors the Yaw Terminal
// release.sh pattern: the manifest repos are checked out next to this one and
// pushed with the gh_woods SSH key -- no CI cross-repo token. The binary BUILD
// is CI (release.yml on tag push); this manifest BUMP runs locally after.
//
//   node scripts/update-manifests.mjs --version 0.60.6 \
//     [--scoop-dir ~/yaw/scoop-yaw] [--homebrew-dir ~/yaw/homebrew-yaw] [--push]
//
// Hashes are pulled with `gh release download v<version> -p '*.sha256'` (needs
// gh auth). Without --push it writes the files and prints the git commands.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const expand = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
const version = arg('version', pkg.version);
const tag = `v${version}`;

// Manifest repo paths: resolved in priority order:
//   1. --scoop-dir / --homebrew-dir CLI flags
//   2. YAW_SCOOP_DIR / YAW_HOMEBREW_DIR env vars
//   3. Hardcoded personal-machine defaults (~/yaw/scoop-yaw etc.)
// On a second machine, set the env vars or pass the flags -- the
// personal defaults only exist on the original dev machine and will
// produce a "no such file or directory" error rather than silently
// writing to a wrong location.
const scoopDir = resolve(expand(arg('scoop-dir', process.env.YAW_SCOOP_DIR ?? '~/yaw/scoop-yaw')));
const homebrewDir = resolve(expand(arg('homebrew-dir', process.env.YAW_HOMEBREW_DIR ?? '~/yaw/homebrew-yaw')));
const push = process.argv.includes('--push');

// --- everything below is derived from package.json (copy-paste generic) ------
const pkgShort = pkg.name.split('/').pop(); // scoop install name + bucket file
const cmd = Object.keys(pkg.bin ?? {})[0] ?? pkgShort; // the on-PATH command
const repoSlug =
  (pkg.repository?.url ?? '')
    .replace(/^git\+/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '') || `YawLabs/${pkgShort}`;
const REPO = `https://github.com/${repoSlug}`;
const homepage = pkg.homepage || REPO;
// CamelCase the command for the Homebrew class (yaw-mcp -> YawMcp).
const className = cmd.split(/[-_]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
const proprietary = !pkg.license || pkg.license === 'UNLICENSED';
const dl = (asset) => `${REPO}/releases/download/${tag}/${asset}`;

// Per-arch asset names (must match stage-release-asset.mjs: <cmd>-<plat>-<arch>).
const ASSETS = {
  winX64: `${cmd}-win32-x64.exe`,
  winArm64: `${cmd}-win32-arm64.exe`,
  macArm64: `${cmd}-darwin-arm64`,
  macX64: `${cmd}-darwin-x64`,
  linuxX64: `${cmd}-linux-x64`,
};

// 1. Pull every .sha256 sidecar from the release into a temp dir, parse hashes.
const shaDir = mkdtempSync(join(tmpdir(), `${cmd}-sha-`));
execFileSync('gh', ['release', 'download', tag, '--repo', repoSlug, '-p', '*.sha256', '-D', shaDir], {
  stdio: 'inherit',
});
const hashes = {};
for (const file of readdirSync(shaDir)) {
  const [hex, name] = readFileSync(join(shaDir, file), 'utf-8').trim().split(/\s+/);
  hashes[name] = hex;
}
function hashFor(asset) {
  const h = hashes[asset];
  if (!h) throw new Error(`missing sha256 sidecar for ${asset} in release ${tag}`);
  return h;
}

// 2. Scoop manifest (architecture.{64bit,arm64}; x64 is "64bit" in Scoop).
const scoopManifest = {
  version,
  description: pkg.description,
  homepage,
  license: { identifier: proprietary ? 'Proprietary' : pkg.license, url: 'https://yaw.sh' },
  architecture: {
    '64bit': { url: dl(ASSETS.winX64), hash: hashFor(ASSETS.winX64), bin: [[ASSETS.winX64, cmd]] },
    arm64: { url: dl(ASSETS.winArm64), hash: hashFor(ASSETS.winArm64), bin: [[ASSETS.winArm64, cmd]] },
  },
  // Belt-and-suspenders: strip any Mark-of-the-Web so SmartScreen never fires
  // (Scoop's own fetch usually leaves none, but a proxied download might).
  post_install: ['Get-ChildItem "$dir\\*.exe" | Unblock-File'],
  checkver: { github: REPO },
  autoupdate: {
    architecture: {
      '64bit': { url: `${REPO}/releases/download/v$version/${ASSETS.winX64}`, hash: { url: '$url.sha256' } },
      arm64: { url: `${REPO}/releases/download/v$version/${ASSETS.winArm64}`, hash: { url: '$url.sha256' } },
    },
  },
};

// 3. Homebrew formula (CLI -> formula, NOT cask).
const licenseLine = proprietary ? 'license :cannot_represent' : `license "${pkg.license}"`;
const formula = `class ${className} < Formula
  desc "${(pkg.description ?? '').replace(/"/g, '\\"')}"
  homepage "${homepage}"
  version "${version}"
  ${licenseLine}

  on_macos do
    on_arm do
      url "${dl(ASSETS.macArm64)}", using: :nounzip
      sha256 "${hashFor(ASSETS.macArm64)}"
    end
    on_intel do
      url "${dl(ASSETS.macX64)}", using: :nounzip
      sha256 "${hashFor(ASSETS.macX64)}"
    end
  end

  on_linux do
    on_intel do
      url "${dl(ASSETS.linuxX64)}", using: :nounzip
      sha256 "${hashFor(ASSETS.linuxX64)}"
    end
  end

  def install
    # Each per-arch release asset is a single bare binary; rename to the command.
    bin.install Dir["*"].first => "${cmd}"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/${cmd} --version")
  end
end
`;

// 4. Write both manifests into the sibling repos.
const scoopRel = `bucket/${pkgShort}.json`;
const formulaRel = `Formula/${cmd}.rb`;
const scoopPath = join(scoopDir, scoopRel);
const formulaPath = join(homebrewDir, formulaRel);
mkdirSync(dirname(scoopPath), { recursive: true });
mkdirSync(dirname(formulaPath), { recursive: true });
writeFileSync(scoopPath, `${JSON.stringify(scoopManifest, null, 2)}\n`);
writeFileSync(formulaPath, formula);
console.log(`wrote ${scoopPath}`);
console.log(`wrote ${formulaPath}`);

// 5. Commit + push (SSH gh_woods, like release.sh) only with --push.
const SSH = 'ssh -i ~/.ssh/gh_woods -o IdentitiesOnly=yes';
function commitPush(dir, file, msg) {
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'inherit', env: { ...process.env, GIT_SSH_COMMAND: SSH } });
  git('pull', '--rebase', 'origin', 'main');
  git('add', file);
  git('commit', '-m', msg);
  git('push', 'origin', 'main');
}
if (push) {
  commitPush(scoopDir, scoopRel, `${cmd} ${version}`);
  commitPush(homebrewDir, formulaRel, `${cmd} ${version}`);
  console.log('pushed scoop-yaw + homebrew-yaw');
} else {
  console.log('\n--push not set. Review, then:');
  console.log(`  git -C ${scoopDir} add ${scoopRel} && git -C ${scoopDir} commit -m "${cmd} ${version}" && git -C ${scoopDir} push`);
  console.log(`  git -C ${homebrewDir} add ${formulaRel} && git -C ${homebrewDir} commit -m "${cmd} ${version}" && git -C ${homebrewDir} push`);
}
