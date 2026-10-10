// `pnpm deploy:selfhost [instance] [alchemy flags]` — one deployment per env
// file, so a single checkout can run several (each on its own Cloudflare
// account or stage):
//
//   pnpm deploy:selfhost --yes            -> .env.selfhost
//   pnpm deploy:selfhost leverage --yes   -> .env.leverage
//
// The env file describes the whole instance. On top of the app's own values
// it may set:
//   DEPLOY_STAGE     alchemy stage, which names every resource. Defaults to
//                    the instance name; an instance first deployed before it
//                    had a name keeps DEPLOY_STAGE=selfhost.
//   ALCHEMY_PROFILE  login profile to deploy with (default "default").
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const instance =
  args[0] && !args[0].startsWith("-") ? args.shift() : "selfhost";
const envFile = `.env.${instance}`;

const fileEnv = {};
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) fileEnv[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

const stage = fileEnv.DEPLOY_STAGE || instance;
const profile =
  fileEnv.ALCHEMY_PROFILE || process.env.ALCHEMY_PROFILE || "default";

// The env file's values go into every step's environment: the preflight
// checks them, and the build bakes the client-side ones (PostHog keys) into
// the bundle — `--mode selfhost` alone would only ever read .env.selfhost.
const env = {
  ...process.env,
  ...fileEnv,
  ALCHEMY_PROFILE: profile,
  SELFHOST_ENV_FILE: envFile,
};
const run = (command, ...commandArgs) =>
  execFileSync(command, commandArgs, { stdio: "inherit", env });

try {
  run("node", "scripts/selfhost-deploy-preflight.mjs");
  console.log(
    `\nDeploying ${envFile} -> stage "${stage}" (profile "${profile}")\n`,
  );
  run("pnpm", "exec", "vite", "build", "--mode", "selfhost");
  run("pnpm", "exec", "tsc", "--noEmit");
  run(
    "pnpm",
    "alchemy",
    "deploy",
    "deploy/alchemy/alchemy.run.ts",
    "--env-file",
    envFile,
    "--stage",
    stage,
    "--profile",
    profile,
    ...args,
  );
} catch (error) {
  // The failing step already printed its own output.
  process.exit(typeof error.status === "number" ? error.status : 1);
}
