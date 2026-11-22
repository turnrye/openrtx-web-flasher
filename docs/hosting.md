# Hosting

`ci/build.sh` produces `dist/`: plain files, every URL relative. It can be served from a
domain root, a sub-folder, or a per-pull-request folder without rebuilding. The only
requirement is HTTPS (or localhost): browsers offer WebUSB, Web Serial and WebHID only
on secure pages.

The firmware in `dist/firmware/` is copied from GitHub at build time, so a host only
gets new releases when the site is rebuilt. Both workflows rebuild nightly.

## GitHub Pages

`.github/workflows/ci.yml` publishes to the `gh-pages` branch:

- push to `main`, nightly, manual run: the site at `https://<owner>.github.io/<repo>/`
- pull request from the repository: `…/pr-preview/pr-<n>/`, with a comment on the pull
  request; removed when it closes
- pull request from a fork: built and tested only (forks get a read-only token); the
  `site` artifact has the build

One-time setup: Settings → Pages → "Deploy from a branch" → `gh-pages`, `/ (root)`.

## Forgejo with git-pages

`.forgejo/workflows/ci.yml` runs the same scripts. Forgejo has no Pages, so the site is
uploaded to a [git-pages](https://codeberg.org/git-pages/git-pages) server. The `pages`
branch has the same layout as `gh-pages`, and its content is uploaded after each change,
so previews are sub-folders of the one site and need nothing special from the server.

One-time setup: repository variable `PAGES_URL` (Settings → Actions → Variables), the
address git-pages serves this repository at, with a trailing slash. Without the variable
the workflow builds and tests and keeps the site as an artifact.

## Any other static host

    ci/build.sh
    rsync -a --delete dist/ user@host:/var/www/flasher/

To publish from CI to something else, add a step after `ci/build.sh`; nothing in the
build knows where it will be served.

Build options (environment):

| Variable        | Meaning                                              | Default                         |
| --------------- | ---------------------------------------------------- | ------------------------------- |
| `ORTX_REPO`     | repository firmware is copied from                   | `OpenRTX/OpenRTX`               |
| `ORTX_RELEASES` | how many releases to bundle                          | 6                               |
| `ORTX_BRANCH`   | branch whose latest CI build is bundled              | `master`                        |
| `GITHUB_TOKEN`  | raises GitHub's API limit for the copy               | none                            |
| `MIRROR=skip`   | build without firmware (offline)                     |                                 |
| `FEEDBACK_URL`  | the tracker's "new issue" address that reports go to | this project's issues on GitHub |
| `BUILD_ID`      | the commit the page says it was built from           | the checked-out commit          |

## Why firmware is copied

A web page may only read files from another site when that site allows it. GitHub's
release downloads and nightly.link do not, and the GitHub API hands out CI builds only
to a logged-in user. So releases and the master build are copied at build time, and
branch builds reach the page as a zip the user downloads and drops in.
