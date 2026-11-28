# Hosting

`ci/build.sh` produces `dist/`: plain files, the flasher and its three pages, and
`radios.json`. Its links are written for the path the site is served under, so the
build has to be told: `SITE_BASE=/ ci/build.sh` for a domain's root,
`SITE_BASE=/flasher/` for a folder. A build made for one path does not work under
another. The other requirement is HTTPS (or localhost): browsers offer WebUSB, Web
Serial and WebHID only on secure pages.

Everything served from one address shares the browser's permission to talk to a radio
and the backups kept in the browser. Do not publish other people's unreviewed pages on
the same address as the flasher: previews of pull requests from forks are not published
for that reason, and should not be.

The firmware in `dist/firmware/` is copied from GitHub at build time, so a host only
gets new releases when the site is rebuilt. Both workflows rebuild nightly.

## GitHub Pages

`.github/workflows/ci.yml` publishes to the `gh-pages` branch:

- push to `main`, nightly, manual run: the site at `https://<owner>.github.io/<repo>/`
- pull request from the repository: `…/pr-preview/pr-<n>/`, with a comment on the pull
  request; removed when it closes. Each is its own build, made for its own path
  (`ci/site-base.sh`)
- pull request from a fork: built and tested only (forks get a read-only token); the
  `site` artifact has the build

One-time setup: Settings → Pages → "Deploy from a branch" → `gh-pages`, `/ (root)`.

On a domain of its own (a `CNAME`), set the repository variable `SITE_ROOT` to `/`:
the site is then at the domain's top, not under `/<repo>/`.

Moved to the OpenRTX organisation as `OpenRTX/flash`, the flasher needs no domain of its
own: GitHub serves an organisation's project sites under the organisation site's domain,
so it is at `https://openrtx.org/flash/`, next to the website.

## Forgejo with git-pages

`.forgejo/workflows/ci.yml` runs the same scripts. Forgejo has no Pages, so the site is
uploaded to a [git-pages](https://codeberg.org/git-pages/git-pages) server. The `pages`
branch has the same layout as `gh-pages`, and its content is uploaded after each change,
so previews are sub-folders of the one site and need nothing special from the server.

One-time setup: repository variable `PAGES_URL` (Settings → Actions → Variables), the
address git-pages serves this repository at, with a trailing slash. Without the variable
the workflow builds and tests and keeps the site as an artifact. The build takes the
path to serve under from that address.

## Any other static host

    SITE_BASE=/flasher/ ci/build.sh
    rsync -a --delete dist/ user@host:/var/www/flasher/

To publish from CI to something else, set `SITE_BASE` and add a step after
`ci/build.sh`.

Build options (environment):

| Variable        | Meaning                                               | Default                           |
| --------------- | ----------------------------------------------------- | --------------------------------- |
| `SITE_BASE`     | the path the site is served under                     | `/sub/path/`, for the tests       |
| `SITE_URL`      | the site's full address, for `flasher` in radios.json | none (radios.json gives the path) |
| `ORTX_REPO`     | repository firmware is copied from                    | `OpenRTX/OpenRTX`                 |
| `ORTX_RELEASES` | how many releases to bundle                           | 6                                 |
| `ORTX_BRANCH`   | branch whose latest CI build is bundled               | `master`                          |
| `GITHUB_TOKEN`  | raises GitHub's API limit for the copy                | none                              |
| `MIRROR=skip`   | build without firmware (offline)                      |                                   |
| `FEEDBACK_URL`  | the tracker's "new issue" address that reports go to  | this project's issues on GitHub   |
| `BUILD_ID`      | the commit the page says it was built from            | the checked-out commit            |

## Why firmware is copied

A web page may only read files from another site when that site allows it. GitHub's
release downloads and nightly.link do not, and the GitHub API hands out CI builds only
to a logged-in user. So releases and the master build are copied at build time, and
branch builds reach the page as a zip the user downloads and drops in.
