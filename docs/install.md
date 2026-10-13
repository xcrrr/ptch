# Installing ptch

The short version is in the [README](../README.md#quick-start). This page has the details.

## Requirements

Node.js 20.19 or newer, pnpm 9 and Git. [ripgrep](https://github.com/BurntSushi/ripgrep) is optional: a built-in search is used when `rg` is missing. No pnpm yet? `corepack enable` (bundled with Node) or `npm install -g pnpm@9`.

## From source

```bash
git clone https://github.com/xcrrr/ptch.git
cd ptch
pnpm install
pnpm build
pnpm setup            # once per machine; skip if pnpm's global bin directory is already on PATH
pnpm link --global
```

Open a new terminal (so it sees the updated PATH) and run `ptch`. `pnpm link --global` links your checkout, so `ptch` always runs the code you last built. The executable is called `ptch` because `patch` is a standard Unix utility. To run without linking: `node apps/cli/dist/main.js`.

## From a release

Once a release is cut, its build is attached to [GitHub Releases](https://github.com/xcrrr/ptch/releases) as `ptch-<version>.tgz` with a `SHA256SUMS` file. Check the checksum, then install the tarball:

```bash
sha256sum --check SHA256SUMS          # macOS: shasum -a 256 -c SHA256SUMS
npm install --global ./ptch-<version>.tgz
```

On Windows, compare `(Get-FileHash .\ptch-<version>.tgz -Algorithm SHA256).Hash` with the line in `SHA256SUMS`. Until a release exists, build from source. Nothing is published to npm.

## Updating

```bash
git pull
pnpm install
pnpm build
```

The linked `ptch` uses the new build right away; there is nothing to reinstall.

## Windows notes

Windows PowerShell refuses to run `ptch` (and `pnpm`) with "running scripts is disabled on this system" when its script policy is still the default. Use Command Prompt or `ptch.cmd`, or allow local scripts once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## Signing in without a browser

In an SSH session or a container no browser can be opened. Set `PATCH_NO_BROWSER=1` or use `ptch login --no-browser`: `ptch` prints the address to open on any device, and `c` copies it. For scripts and CI there is a static connection: `PATCH_CLOUD_URL` and `PATCH_CLOUD_TOKEN` override the saved sign-in.
