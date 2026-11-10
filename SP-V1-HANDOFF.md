# SP-V1 handoff (temporary files — delete once the repo is populated)

`SP-V1-v1.0.patch` is the **entire finished SP-V1 project** as a git patch: 2
commits, 10 files, 2 169 lines, `npm test` = **249 checks passing** (181 against
stubs + 68 over real HTTP on three loopback servers). Verified by applying the
patch into an empty repo and running the suite there: the restored tree hashes
identical to the working one.

It lives here because the GitHub connection in this Arena session can write to
`sp-vpn-hub` but every write to `Kaixx23/SP-V1` is refused — `gh api` says
*Resource not accessible by integration* (403) and git-over-HTTPS says *Permission
denied*, on both the contents API and the git-data API. The repo is empty, so
nothing has been lost; the work just has not been delivered yet.

## Option A — authorise the new repo, then I push it

GitHub → **Settings → Applications → (the Arena GitHub app) → Configure → Only
select repositories** → add `SP-V1`. Then say "push SP-V1": `main` plus the `v1.0`
tag (already created locally, `git push --follow-tags`) land in one go, and these
two files get deleted.

## Option B — apply it yourself

```bash
git init SP-V1 && cd SP-V1
git remote add origin https://github.com/Kaixx23/SP-V1.git
git am SP-V1-v1.0.patch                     # or: git apply --index, then commit
git tag -a v1.0 -m "v1.0 — byte-exact passthrough converter"
git push -u origin main --follow-tags
```

No `git am`? The patch is plain text — open it, save the 10 files by hand, commit.
Nothing else is required: no build step, one dependency (`@libsql/client`).

## Then, on Netlify

Import the repo as a **new site** (netlify.toml handles the function wiring) and set:

| Variable | Value |
| --- | --- |
| `TOKEN_STORE_URL` | identical to the hub's — this is what makes existing customer tokens work on the new host |
| `TOKEN_STORE_AUTH_TOKEN` | identical to the hub's |
| `HUB_BASE_URL` | `https://sp-vpn.netlify.app` (only needed for `?profile=safe`) |

Customer link: `https://<new-site>/e/<token>` — same token, so nothing else changes.

## Prove it

```bash
npm test
node bin/verify-live.mjs https://<new-site>.netlify.app <token>
```

`verify-live` fetches the new site's own public URL and the supplier's response
independently and diffs them **byte by byte**; `identical: true` is the whole
claim of the project, checked against production rather than against this repo.
