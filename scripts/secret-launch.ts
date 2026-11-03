#!/usr/bin/env bun
import {
  clearSecretsFromProcessEnv,
  decryptVault,
  editVault,
  launchService,
  SECRET_KEYS,
  SecretVaultError,
  validateAgeIdentity,
  type AgeIdentity,
  type SecretValues,
} from "../lib/secrets/vault";

const USAGE = `secret-launch — load a SOPS vault and restart the OpenCode service

Usage:
  bun run scripts/secret-launch.ts --vault <path> --age-key-file <path> [--restart] [--opencode <path>]
  bun run scripts/secret-launch.ts --vault <path> --age-encrypted-identity <path> [--restart] [--opencode <path>]
  bun run scripts/secret-launch.ts --vault <path> --age-encrypted-identity <path> --edit

Options:
  --vault <path>                  SOPS-encrypted YAML vault (required)
  --age-key-file <path>           Plaintext age identity outside the Git checkout
  --age-encrypted-identity <path> Passphrase-protected age identity. On Windows this
                                  path was user-tested against the real vault. Runs
                                  "age -d" interactively, keeps the identity in memory,
                                  and passes it to SOPS via SOPS_AGE_KEY. Linux
                                  interactive prompt/TTY behavior is unverified.
  --edit                          Open "sops <vault>" with the identity in memory.
                                  The editor may create plaintext temp/swap files.
  --restart                       Run "opencode service restart" with the loaded environment
  --opencode <path>               Trusted OpenCode executable (default: opencode).
                                  Only an opencode/opencode.exe/opencode.cmd basename
                                  is accepted. This is a name check, not integrity
                                  verification; a malicious binary on PATH can share the
                                  name. Prefer a trusted absolute path.
  --help                          Show this help

Without --restart or --edit this is a dry run: it decrypts, validates, and prints
only the names of the fields that were accepted. No secret values, sops stderr,
or service status are printed. Run --restart only while the service is idle.

The Windows passphrase-protected identity path has been tested by the user against
the real vault. Linux interactive behavior and whether the restarted background
service inherits the loaded or ambient environment remain unverified. A direct
service launch preserves ambient caller variables outside the documented
allowlist and SOPS identity variables. This installed sops 3.7.3 does not support
SOPS_AGE_KEY_CMD.
`;

type Parsed = {
  vault?: string;
  identity?: AgeIdentity;
  restart: boolean;
  edit: boolean;
  opencode?: string;
  help: boolean;
};

function takeValue(argv: string[], index: number, flag: string): [string, number] {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new SecretVaultError("invalid-vault", `${flag} requires a value`);
  }
  return [value, index + 1];
}

function parseArgv(argv: string[]): Parsed {
  const parsed: Parsed = { restart: false, edit: false, help: false };
  let ageKeyFile: string | undefined;
  let ageEncryptedIdentity: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--restart") {
      parsed.restart = true;
      continue;
    }
    if (arg === "--edit") {
      parsed.edit = true;
      continue;
    }
    if (arg === "--vault") {
      [parsed.vault, index] = takeValue(argv, index, arg);
      continue;
    }
    if (arg === "--age-key-file") {
      [ageKeyFile, index] = takeValue(argv, index, arg);
      continue;
    }
    if (arg === "--age-encrypted-identity") {
      [ageEncryptedIdentity, index] = takeValue(argv, index, arg);
      continue;
    }
    if (arg === "--opencode") {
      [parsed.opencode, index] = takeValue(argv, index, arg);
      continue;
    }
    throw new SecretVaultError("invalid-vault", "unknown argument");
  }

  if (parsed.help) return parsed;
  if (!parsed.vault) {
    throw new SecretVaultError("invalid-vault", "--vault is required");
  }
  if (ageKeyFile !== undefined && ageEncryptedIdentity !== undefined) {
    throw new SecretVaultError(
      "invalid-identity",
      "choose exactly one identity mechanism: --age-key-file or --age-encrypted-identity",
    );
  }
  if (ageKeyFile !== undefined) {
    parsed.identity = { kind: "age-key-file", path: ageKeyFile };
  } else if (ageEncryptedIdentity !== undefined) {
    parsed.identity = { kind: "age-encrypted-identity", path: ageEncryptedIdentity };
  } else {
    throw new SecretVaultError(
      "invalid-identity",
      "an identity mechanism is required: --age-key-file or --age-encrypted-identity",
    );
  }
  if (parsed.edit && parsed.restart) {
    throw new SecretVaultError("invalid-vault", "--edit and --restart cannot be combined");
  }
  return parsed;
}

function describe(secrets: SecretValues): string {
  const present = SECRET_KEYS.filter((key) => secrets[key] !== undefined);
  return present.length > 0 ? present.join(", ") : "(none)";
}

function scrub(secrets: SecretValues): void {
  for (const key of SECRET_KEYS) {
    if (secrets[key] !== undefined) secrets[key] = "";
  }
}

async function main(): Promise<number> {
  let secrets: SecretValues = {};
  try {
    const parsed = parseArgv(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(USAGE);
      return 0;
    }

    validateAgeIdentity(parsed.identity!);

    if (parsed.edit) {
      process.stdout.write(
        "secret-launch: opening the SOPS editor with the identity in memory. " +
          "The editor may create plaintext temp/swap/recovery files; " +
          "close it cleanly and check its recovery directory afterward.\n",
      );
      const result = await editVault({
        vaultPath: parsed.vault!,
        identity: parsed.identity!,
      });
      process.stdout.write(`secret-launch: editor exited with code ${result.code}.\n`);
      // SOPS uses 200 for "file has not changed"; that is not an edit failure.
      return result.code === 0 || result.code === 200 ? 0 : 1;
    }

    process.stdout.write("secret-launch: decrypting vault in memory...\n");
    secrets = await decryptVault({
      vaultPath: parsed.vault!,
      identity: parsed.identity!,
    });
    process.stdout.write(`secret-launch: accepted fields: ${describe(secrets)}\n`);

    if (!parsed.restart) {
      process.stdout.write(
        "secret-launch: dry run complete; no command was executed. " +
          "Use --restart during an idle window to restart the service with this environment.\n",
      );
      return 0;
    }

    process.stdout.write(
      "secret-launch: WARNING: restarting the OpenCode background service. " +
        "Finish or pause active sessions first; this is not a config-only reload.\n",
    );
    const command = [
      parsed.opencode ?? "opencode",
      "service",
      "restart",
    ] as const;
    const result = await launchService({ secrets, command });
    process.stdout.write(
      `secret-launch: service restart command exited with code ${result.code}.\n`,
    );
    return result.code === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof SecretVaultError) {
      process.stderr.write(`secret-launch: ${error.message}\n`);
      return 1;
    }
    // Unexpected failures may carry implementation details; keep them generic.
    process.stderr.write("secret-launch: unexpected failure\n");
    return 1;
  } finally {
    scrub(secrets);
    clearSecretsFromProcessEnv();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stderr.write("secret-launch: unexpected failure\n");
    process.exitCode = 1;
  },
);
