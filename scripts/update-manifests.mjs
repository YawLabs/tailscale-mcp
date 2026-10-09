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

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..");

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}
const expand = (p) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

// Escape a value for the inside of a Ruby double-quoted string literal. The
// backslash goes first, or the backslashes added for the other characters get
// doubled. `#` is escaped only where it starts interpolation -- `#{...}`, `#@x`
// and `#$x` run as Ruby inside double quotes when brew loads the formula -- so
// a plain `#` ("C# support") stays as written and brew style does not flag a
// redundant escape. Raw CR/LF become `\r`/`\n` so a multi-line value cannot
// spill out of its one-line stanza.
export function rubyString(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/#(?=[{@$])/g, "\\#")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

// Render the Homebrew formula (CLI -> formula, NOT cask). Every value that
// lands inside a Ruby string goes through rubyString; the class name is a bare
// Ruby constant, so it is checked instead of escaped. `license` null/undefined
// renders `license :cannot_represent` (proprietary).
//   assets: { macArm64, macX64, linuxX64 }, each { url, sha256 }
export function renderFormula({ className, cmd, description, homepage, version, license, assets }) {
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(className)) {
    throw new Error(`invalid Homebrew class name ${JSON.stringify(className)}`);
  }
  const q = rubyString;
  const licenseLine = license ? `license "${q(license)}"` : "license :cannot_represent";
  return `class ${className} < Formula
  desc "${q(description)}"
  homepage "${q(homepage)}"
  version "${q(version)}"
  ${licenseLine}

  on_macos do
    on_arm do
      url "${q(assets.macArm64.url)}", using: :nounzip
      sha256 "${q(assets.macArm64.sha256)}"
    end
    on_intel do
      url "${q(assets.macX64.url)}", using: :nounzip
      sha256 "${q(assets.macX64.sha256)}"
    end
  end

  on_linux do
    on_intel do
      url "${q(assets.linuxX64.url)}", using: :nounzip
      sha256 "${q(assets.linuxX64.sha256)}"
    end
  end

  def install
    # Each per-arch release asset is a single bare binary; rename to the command.
    bin.install Dir["*"].first => "${q(cmd)}"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/${q(cmd)} --version")
  end
end
`;
}

// Pull every .sha256 sidecar from the release into a temp dir and parse them
// into { assetName: hex }. This is the script's only network call; main()
// takes it as a parameter so a test can stub it.
function ghReleaseHashes({ tag, repoSlug, cmd }) {
  const shaDir = mkdtempSync(join(tmpdir(), `${cmd}-sha-`));
  try {
    execFileSync("gh", ["release", "download", tag, "--repo", repoSlug, "-p", "*.sha256", "-D", shaDir], {
      stdio: "inherit",
    });
    const hashes = {};
    for (const file of readdirSync(shaDir)) {
      const [hex, name] = readFileSync(join(shaDir, file), "utf-8").trim().split(/\s+/);
      hashes[name] = hex;
    }
    return hashes;
  } finally {
    // The sidecars hold no secret, but a re-run would otherwise accumulate a
    // throwaway directory per invocation. rmSync recursive+force: the dir may
    // hold downloaded files and must not throw on an already-gone path.
    rmSync(shaDir, { recursive: true, force: true });
  }
}

export function main({ argv = process.argv, fetchHashes = ghReleaseHashes, root = repoRoot } = {}) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  const version = arg(argv, "version", pkg.version);
  const tag = `v${version}`;

  // Manifest repo paths: resolved in priority order:
  //   1. --scoop-dir / --homebrew-dir CLI flags
  //   2. YAW_SCOOP_DIR / YAW_HOMEBREW_DIR env vars
  //   3. Hardcoded personal-machine defaults (~/yaw/scoop-yaw etc.)
  // On a second machine, set the env vars or pass the flags -- the
  // personal defaults only exist on the original dev machine and will
  // produce a "no such file or directory" error rather than silently
  // writing to a wrong location.
  const scoopDir = resolve(expand(arg(argv, "scoop-dir", process.env.YAW_SCOOP_DIR ?? "~/yaw/scoop-yaw")));
  const homebrewDir = resolve(expand(arg(argv, "homebrew-dir", process.env.YAW_HOMEBREW_DIR ?? "~/yaw/homebrew-yaw")));
  const push = argv.includes("--push");

  // --- everything below is derived from package.json (copy-paste generic) ------
  const pkgShort = pkg.name.split("/").pop(); // scoop install name + bucket file
  const cmd = Object.keys(pkg.bin ?? {})[0] ?? pkgShort; // the on-PATH command
  const repoSlug =
    (pkg.repository?.url ?? "")
      .replace(/^git\+/, "")
      .replace(/^https?:\/\/github\.com\//, "")
      .replace(/\.git$/, "") || `YawLabs/${pkgShort}`;
  const REPO = `https://github.com/${repoSlug}`;
  const homepage = pkg.homepage || REPO;
  // CamelCase the command for the Homebrew class (yaw-mcp -> YawMcp).
  const className = cmd
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  const proprietary = !pkg.license || pkg.license === "UNLICENSED";
  const dl = (asset) => `${REPO}/releases/download/${tag}/${asset}`;

  // Per-arch asset names (must match stage-release-asset.mjs: <cmd>-<plat>-<arch>).
  const ASSETS = {
    winX64: `${cmd}-win32-x64.exe`,
    winArm64: `${cmd}-win32-arm64.exe`,
    macArm64: `${cmd}-darwin-arm64`,
    macX64: `${cmd}-darwin-x64`,
    linuxX64: `${cmd}-linux-x64`,
  };

  // 1. Per-asset sha256s from the release's sidecars.
  const hashes = fetchHashes({ tag, repoSlug, cmd });
  function hashFor(asset) {
    const h = hashes[asset];
    if (!h) throw new Error(`missing sha256 sidecar for ${asset} in release ${tag}`);
    return h;
  }

  // 2. Scoop manifest (architecture.{64bit,arm64}; x64 is "64bit" in Scoop).
  // Serialized with JSON.stringify below, which does all the escaping JSON needs.
  const scoopManifest = {
    version,
    description: pkg.description,
    homepage,
    license: { identifier: proprietary ? "Proprietary" : pkg.license, url: "https://yaw.sh" },
    architecture: {
      "64bit": { url: dl(ASSETS.winX64), hash: hashFor(ASSETS.winX64), bin: [[ASSETS.winX64, cmd]] },
      arm64: { url: dl(ASSETS.winArm64), hash: hashFor(ASSETS.winArm64), bin: [[ASSETS.winArm64, cmd]] },
    },
    // Belt-and-suspenders: strip any Mark-of-the-Web so SmartScreen never fires
    // (Scoop's own fetch usually leaves none, but a proxied download might).
    post_install: ['Get-ChildItem "$dir\\*.exe" | Unblock-File'],
    checkver: { github: REPO },
    autoupdate: {
      architecture: {
        "64bit": { url: `${REPO}/releases/download/v$version/${ASSETS.winX64}`, hash: { url: "$url.sha256" } },
        arm64: { url: `${REPO}/releases/download/v$version/${ASSETS.winArm64}`, hash: { url: "$url.sha256" } },
      },
    },
  };

  // 3. Homebrew formula.
  const asset = (name) => ({ url: dl(name), sha256: hashFor(name) });
  const formula = renderFormula({
    className,
    cmd,
    description: pkg.description,
    homepage,
    version,
    license: proprietary ? null : pkg.license,
    assets: { macArm64: asset(ASSETS.macArm64), macX64: asset(ASSETS.macX64), linuxX64: asset(ASSETS.linuxX64) },
  });

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
  const SSH = "ssh -i ~/.ssh/gh_woods -o IdentitiesOnly=yes";
  function commitPush(dir, file, msg) {
    const git = (...a) =>
      execFileSync("git", ["-C", dir, ...a], { stdio: "inherit", env: { ...process.env, GIT_SSH_COMMAND: SSH } });
    git("pull", "--rebase", "origin", "main");
    // A re-run after a partial push finds the file already committed (and
    // pushed): `git commit` then exits 1, execFileSync throws, and the script
    // aborts with scoop pushed but homebrew never attempted. Skip the whole
    // commit+push for an unchanged file -- real git failures (pull, add, push)
    // still throw.
    const status = execFileSync("git", ["-C", dir, "status", "--porcelain", "--", file], {
      encoding: "utf-8",
      env: { ...process.env, GIT_SSH_COMMAND: SSH },
    }).trim();
    if (status === "") {
      console.log(`unchanged, nothing to commit or push: ${join(dir, file)}`);
      return;
    }
    git("add", file);
    git("commit", "-m", msg);
    git("push", "origin", "main");
  }
  if (push) {
    commitPush(scoopDir, scoopRel, `${cmd} ${version}`);
    commitPush(homebrewDir, formulaRel, `${cmd} ${version}`);
    console.log("pushed scoop-yaw + homebrew-yaw");
  } else {
    console.log("\n--push not set. Review, then:");
    console.log(
      `  git -C ${scoopDir} add ${scoopRel} && git -C ${scoopDir} commit -m "${cmd} ${version}" && git -C ${scoopDir} push`,
    );
    console.log(
      `  git -C ${homebrewDir} add ${formulaRel} && git -C ${homebrewDir} commit -m "${cmd} ${version}" && git -C ${homebrewDir} push`,
    );
  }
  return { scoopPath, formulaPath };
}

// Run the release side effects only when this file is executed directly, so a
// test can import it without triggering `gh release download`. Compare REAL
// paths: reached through a junction or symlink, argv[1] and import.meta.url
// name the same file by different paths.
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {
    return false;
  }
}
if (invokedDirectly()) main();
