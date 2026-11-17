import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
// Child processes receive no deployment variables, credentials or user config.
const cleanEnv = (configDir) => ({
  PATH: process.env.PATH,
  CI: "true",
  COREPACK_ENABLE_NETWORK: "0",
  npm_config_offline: "true",
  npm_config_userconfig: "/dev/null",
  npm_config_globalconfig: "/dev/null",
  XDG_CONFIG_HOME: configDir,
});

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "carebridge-operator-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("documented maintenance commands dispatch via pnpm 9 exec in the scripts workspace", (t) => {
  const dir = fixture(t);
  const workspace = join(dir, "tooling/scripts");
  mkdirSync(join(workspace, "node_modules/.bin"), { recursive: true });
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, packageManager: json("package.json").packageManager }));
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'tooling/*'\n");
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: json("tooling/scripts/package.json").name, private: true }));
  // A recording executable replaces tsx. No real maintenance module is copied,
  // imported or run, even when a documented command includes --dry-run.
  writeFileSync(join(workspace, "node_modules/.bin/tsx"), `#!${process.execPath}\nconsole.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));\n`, { mode: 0o755 });
  writeFileSync(join(workspace, "src/re-encrypt-phi.ts"), "throw new Error('must never execute');\n");
  const env = cleanEnv(dir);
  const version = spawnSync("pnpm", ["--version"], { cwd: dir, env, encoding: "utf8", timeout: 10000 });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout.trim(), /^9\./, "dispatch regression requires pnpm 9");

  for (const path of ["docs/phi-key-rotation.md", "tooling/scripts/src/re-encrypt-phi.ts", ".env.example"]) {
    const commands = read(path).split("\n").map((line) => line.replace(/^\s*(?:\*|#)?\s*/, ""))
      .filter((line) => line.startsWith("pnpm ") && line.includes("re-encrypt-phi.ts"));
    assert.ok(commands.length > 0, `${path} needs the canonical maintenance command`);
    for (const command of commands) {
      assert.match(command, /^pnpm --filter @carebridge\/scripts exec tsx src\/re-encrypt-phi\.ts(?: --(?:dry-run|table=[a-z_]+|batch-size=\d+))*$/, path);
      const args = command.split(" ").slice(1);
      assert.ok(readFileSync(join(root, "tooling/scripts", args[4]), "utf8"));
      const result = spawnSync("pnpm", args, { cwd: dir, env, encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 0, `${path}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout.trim()), { cwd: workspace, args: args.slice(4) });
    }
  }
});

test("quickstarts and runbook explicitly export a trusted shell-compatible environment", (t) => {
  const dir = fixture(t);
  // Synthetic values deliberately include spaces and shell expansion: this is
  // a trusted shell file, not a dotenv parser and not a real deployment file.
  const redisAssignments = read(".env.example").split("\n")
    .filter((line) => /^REDIS_(?:PASSWORD|URL)=/.test(line))
    .map((line) => line.startsWith("REDIS_PASSWORD=") ? 'REDIS_PASSWORD="synthetic redis"' : line);
  assert.equal(redisAssignments.length, 2, "template must define Redis password and URL");
  writeFileSync(join(dir, ".env"), 'OPERATOR_SYNTHETIC_BASE="synthetic value"\nOPERATOR_SYNTHETIC_EXPORTED="${OPERATOR_SYNTHETIC_BASE} exported"\n' + redisAssignments.join("\n") + "\n");
  for (const path of ["README.md", "CLAUDE.md", "docs/phi-key-rotation.md"]) {
    const source = read(path);
    assert.ok(/trusted[\s\S]{0,80}shell-compatible/i.test(source), `${path}: trusted shell-compatible file required`);
    assert.ok(/already.exported|exported deployment environment/i.test(source), `${path}: exported deployment environment alternative required`);
    assert.ok(/do(?:es)? not (?:automatically )?(?:auto)?load|no automatic .*loading/i.test(source), `${path}: no autoload assumption`);
    const snippet = source.match(/^set -a\r?\n\. \.\/\.env\r?\nset \+a$/m)?.[0];
    assert.ok(snippet, `${path} needs an explicit shell export snippet`);
    const probe = `${snippet}\n"$OPERATOR_TEST_NODE" -e 'console.log(JSON.stringify([process.env.OPERATOR_SYNTHETIC_BASE,process.env.OPERATOR_SYNTHETIC_EXPORTED,process.env.REDIS_URL]))'`;
    const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-eu", "-c", probe], {
      cwd: dir, env: { ...cleanEnv(dir), OPERATOR_TEST_NODE: process.execPath }, encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 0, `${path}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), ["synthetic value", "synthetic value exported", "redis://:synthetic redis@localhost:6379"]);
  }
});

test("Turbo strict mode passes both existing rotation/auth runtime variable names", () => {
  const names = json("turbo.json").globalPassThroughEnv;
  for (const name of ["REFRESH_TOKEN_HMAC_KEY", "PHI_ENCRYPTION_KEY_PREVIOUS"]) {
    assert.equal(names.filter((entry) => entry === name).length, 1, name);
  }
  assert.ok(names.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name)), "passthrough names must be explicit, without values or wildcards");
});

test("operator references avoid legacy paths and nonexistent commands", () => {
  assert.ok(!read(".env.example").includes("tsx packages/db-schema/src/rotate-keys.ts"), "remove the legacy patients-only command");
  assert.ok(!read("docs/phi-key-rotation.md").includes("smoke-phi-read.ts"), "remove the nonexistent smoke script");
  assert.ok(!read("tooling/scripts/src/re-encrypt-phi.ts").includes("pnpm --filter @carebridge/scripts test"), "remove the nonexistent scripts test command");
  assert.ok(json("packages/db-schema/package.json").scripts.test, "documented schema test command exists");
  assert.match(json("package.json").scripts.test, /node --test scripts\/operator-commands\.test\.mjs/, "root test must run the regression guard");
});
