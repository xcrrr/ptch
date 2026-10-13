# Releasing

This page is for maintainers. It describes how to cut a release of the `ptch` CLI and how to attach the Android beta APK to a release. Nothing here runs by itself: every step is a command you type.

A release is a Git tag plus a GitHub Release with two files attached:

- `ptch-<version>.tgz`, the bundled CLI (install with `npm install --global ./ptch-<version>.tgz`),
- `SHA256SUMS`, the checksum of the tarball.

Patch is not published to npm. The package name `@patch/cli` is a placeholder.

## Cut a CLI release

1. **Pick the version.** Edit `version` in `apps/cli/package.json` (for example `0.2.0`; use `0.2.0-rc.1` for a release candidate). `ptch --version` reads it.
2. **Update `CHANGELOG.md`.** Rename `Unreleased` to the version with the date, and start a new empty `Unreleased` section.
3. **Check everything locally.**

   ```bash
   pnpm install --frozen-lockfile
   pnpm check            # typecheck, lint, format check, unit tests, build
   pnpm pack:cli         # writes release/ptch-<version>.tgz and release/SHA256SUMS
   ```

   Try the tarball in a scratch directory, not in your checkout:

   ```bash
   npm install --prefix "$(mktemp -d)" ./release/ptch-<version>.tgz
   ```

4. **Commit, tag, push the tag.**

   ```bash
   git commit -am "Release <version>"
   git tag -a v<version> -m "ptch <version>"
   git push origin main v<version>
   ```

   The tag starts the `Release` workflow (`.github/workflows/release.yml`), which has two jobs. `build` has a read-only token: it runs `pnpm check`, builds the tarball, verifies that the tag matches `apps/cli/package.json`, and keeps `ptch-<version>.tgz` and `SHA256SUMS` as a workflow artifact. `publish` is the only job with a write token: it downloads that artifact, checks the checksum and creates the GitHub Release. It checks out nothing and installs nothing. Only the `GITHUB_TOKEN` that Actions provides is used. Versions before 1.0 and tags with a suffix are marked as pre-releases. No secrets are involved.

5. **Check the result.** Download `ptch-<version>.tgz` and `SHA256SUMS` from the release page and verify them:

   ```bash
   sha256sum --check SHA256SUMS         # macOS: shasum -a 256 -c SHA256SUMS
   ```

   ```powershell
   (Get-FileHash .\ptch-<version>.tgz -Algorithm SHA256).Hash.ToLower()   # compare with SHA256SUMS
   ```

6. **Edit the release notes** on GitHub if the generated ones need a human summary (copy it from `CHANGELOG.md`).

If the workflow fails, fix the problem, delete the tag and the draft release, and tag again. To rehearse without a release, run the workflow by hand (Actions → Release → Run workflow): it builds the files and keeps them as a workflow artifact.

### Without the workflow

If you would rather do it yourself, after step 3:

```bash
gh release create v<version> release/ptch-<version>.tgz release/SHA256SUMS \
  --title "ptch v<version>" --notes-file release-notes.md --prerelease
```

## Attach the Android APK

The Android app is a private beta. Its build is made outside this repository, and the APK is only distributed to invited testers. To attach a build to a release:

1. **Build the release APK** with the release signing key. The key never goes into this repository, a workflow or a release; keep an offline backup of it. Name the file `patch-android-<version>.apk`.

2. **Verify the signature and read the certificate fingerprint.** It must match the fingerprint below; if it does not, the APK was signed with another key and must not be published.

   ```bash
   apksigner verify --print-certs patch-android-<version>.apk
   ```

   Expected `Signer #1 certificate SHA-256 digest`:

   ```text
   60cdd3364d1a203131a7a481dec27289cb92b8886f659e9d3e9882dabe2519f7
   ```

3. **Compute the file checksum.**

   ```bash
   sha256sum patch-android-<version>.apk > patch-android-<version>.apk.sha256
   ```

   ```powershell
   (Get-FileHash .\patch-android-<version>.apk -Algorithm SHA256).Hash.ToLower()
   ```

4. **Write the release notes** with the checksum and the fingerprint, so people can check the download:

   ```markdown
   Android private beta build (invitation only).

   - File: patch-android-<version>.apk
   - SHA-256 of the file: <paste the checksum>
   - Signing certificate SHA-256: 60cdd3364d1a203131a7a481dec27289cb92b8886f659e9d3e9882dabe2519f7

   Install on a device that allows installing from this source. Updates must be signed with the same certificate; if the fingerprint differs, do not install.
   ```

5. **Attach it.** If the `Release` workflow created the release (the usual way), upload the APK to it:

   ```bash
   gh release upload v<version> patch-android-<version>.apk patch-android-<version>.apk.sha256
   ```

   If you are not using the workflow, create the release by hand with the CLI files and the APK together (do not do this for a tag the workflow also builds: it would find the release already there and fail):

   ```bash
   gh release create v<version> \
     release/ptch-<version>.tgz release/SHA256SUMS \
     patch-android-<version>.apk patch-android-<version>.apk.sha256 \
     --title "ptch v<version>" --notes-file release-notes.md --prerelease
   ```

   Then open the release page and check that both files are there and that the checksum in the notes matches the one GitHub shows for the asset.

Do not commit APKs, keystores or certificates' private halves to the repository; the `.gitignore` blocks the usual extensions. The release workflow never builds, signs or uploads an APK: you attach it yourself, from your machine, with the commands above.
