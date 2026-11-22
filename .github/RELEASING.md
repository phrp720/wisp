# Releasing Wisp

A release is a tag. Push `v0.1.0` and `.github/workflows/release.yml` does the rest:

1. **Check:** the tag must match `cli/package.json`'s version; typecheck and tests must pass.
2. **Build:** the five binaries (macOS and Linux on arm64 and x64, Windows on x64), each
   packed with the README and licence, plus `SHA256SUMS`.
3. **GitHub Release:** the archives, with notes generated from the merged pull requests.
4. **npm**, when switched on (below).

The archives have no version in their names, so
`https://github.com/phrp720/wisp/releases/latest/download/wisp-darwin-arm64.tar.gz`
always points at the newest. The install script (`website/public/install.sh`) relies on that.

## Cutting a release

```bash
# 1. Bump the version in both places (a test keeps them equal)
#    cli/package.json        "version": "0.2.0"
#    cli/src/cli/version.ts  export const VERSION = "0.2.0";
# 2. Commit, merge to main, then tag it:
git tag v0.2.0
git push origin v0.2.0
```

## Switching channels on

Everything below lives in the repository's **Settings → Secrets and variables → Actions**.
Secrets are encrypted and never appear in logs or in this repository.

| Channel | Variable | Secret |
|---|---|---|
| npm (`@squaredasher/wisp`) | `PUBLISH_NPM` = `true` | none: `release.yml` is the package's trusted publisher (below) |
| Website (Cloudflare Worker, on every push to main) | `DEPLOY_WEBSITE` = `true` | `CLOUDFLARE_API_TOKEN` (the *Edit Cloudflare Workers* template) and `CLOUDFLARE_ACCOUNT_ID` |

### npm, without a token

npm trusts this workflow directly, so no token is stored anywhere. A trusted publisher can only
be added to a package that exists, so the very first version is published once by hand:

```bash
cd cli && npm login && npm publish --access public
```

Then on npmjs.com, open the package's **Settings, Trusted Publisher**, choose GitHub Actions,
and enter `phrp720`, `wisp` and `release.yml`. Set `PUBLISH_NPM` = `true`, and every later tag
publishes by itself.

npm packages are published with provenance, so npm shows they were built by this workflow
from this repository.

