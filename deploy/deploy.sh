#!/usr/bin/env bash
# Publishes the website on the production server (the Hostinger VPS). Run it ON the server.
#
#   deploy.sh                 build and publish origin/main
#   deploy.sh <commit|tag>    build and publish that commit
#   deploy.sh --rollback      go back to the release before the current one
#   deploy.sh --list          show the releases kept on the server
#
# It pulls the commit from GitHub, builds it in the checkout, checks the result, copies it
# to a new release folder and repoints the "current" link, which is what Nginx serves. The
# switch is one rename, so a visitor never sees half a site, and a failed build or check
# leaves the live site untouched.
#
# Layout under $APP_DIR (first-time setup: DEPLOYMENT.md):
#   repo/              git checkout of the repository. Never served.
#   shared/site.env    the build variables for this server. Public values only.
#   releases/<id>/     one folder of built files per deployment
#   current            link to the live release
#
# The backend is not deployed from here. It is Supabase Edge Functions, deployed with the
# Supabase CLI from a developer machine. No secret belongs on this server.
set -euo pipefail

# The braces make bash read the whole script before running any of it: the checkout below
# replaces this very file when it is run from inside the repository.
{

APP_DIR="${APP_DIR:-/var/www/luzenarestaurant.com}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
REPO="$APP_DIR/repo"
RELEASES="$APP_DIR/releases"
ENV_FILE="$APP_DIR/shared/site.env"
# One small file per release: the names of the hashed files that release built.
OWN_ASSETS="$APP_DIR/shared/own-assets"

# The Supabase project each environment must use. A site built against the other one is
# refused: the test project must never serve the live site, nor the reverse.
PRODUCTION_SUPABASE_URL="https://xqzpuqjrlrxyitjubkqk.supabase.co"
TEST_SUPABASE_URL="https://cgxhifkeoesvsycewwfs.supabase.co"

fail() { echo "deploy: $*" >&2; exit 1; }
live_release() { [ -L "$APP_DIR/current" ] && basename "$(readlink "$APP_DIR/current")" || true; }

switch_to() {
  # A new link renamed over the old one: atomic, unlike `ln -sfn`.
  ln -s "releases/$1" "$APP_DIR/current.new"
  mv -T "$APP_DIR/current.new" "$APP_DIR/current"
}

[ -d "$RELEASES" ] || fail "$RELEASES does not exist. Do the first-time setup in DEPLOYMENT.md."

case "${1:-}" in
  --list)
    live="$(live_release)"
    for dir in $(ls -1 "$RELEASES" | sort); do
      [ "$dir" = "$live" ] && echo "$dir   <- live" || echo "$dir"
    done
    exit 0
    ;;
  --rollback)
    live="$(live_release)"
    [ -n "$live" ] || fail "nothing is live, so there is nothing to roll back."
    previous="$(ls -1 "$RELEASES" | sort | grep -B1 -x -F "$live" | head -n 1 || true)"
    [ -n "$previous" ] && [ "$previous" != "$live" ] || fail "there is no release older than $live."
    switch_to "$previous"
    echo "deploy: rolled back from $live to $previous."
    exit 0
    ;;
esac

REF="${1:-origin/main}"

[ -d "$REPO/.git" ] || fail "$REPO is not a git checkout. Do the first-time setup in DEPLOYMENT.md."
[ -f "$ENV_FILE" ] || fail "$ENV_FILE is missing. It holds DEPLOY_ENVIRONMENT, VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
command -v node >/dev/null || fail "node is not installed."
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 19) ? 0 : 1)' \
  || fail "Node $(node -v) is too old. The build needs 20.19 or newer."

# Build variables. Everything in this file ends up in the public website.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

[ -z "${CONTENT_PROFILE:-}" ] || fail "CONTENT_PROFILE is set. It would publish the sample content. Remove it from $ENV_FILE."
[ -z "${VITE_DASHBOARD_DEMO:-}" ] || fail "VITE_DASHBOARD_DEMO is set. Remove it from $ENV_FILE."
[ -n "${VITE_SUPABASE_URL:-}" ] || fail "VITE_SUPABASE_URL is not set in $ENV_FILE."
[ -n "${VITE_SUPABASE_ANON_KEY:-}" ] || fail "VITE_SUPABASE_ANON_KEY is not set in $ENV_FILE."
case "$VITE_SUPABASE_ANON_KEY" in
  sb_secret_*) fail "VITE_SUPABASE_ANON_KEY holds a SECRET key. Only the publishable key may be here: this value is published." ;;
esac
case "${DEPLOY_ENVIRONMENT:-}" in
  production) expected="$PRODUCTION_SUPABASE_URL" ;;
  test) expected="$TEST_SUPABASE_URL" ;;
  *) fail "DEPLOY_ENVIRONMENT in $ENV_FILE must be 'production' or 'test'." ;;
esac
[ "${VITE_SUPABASE_URL%/}" = "$expected" ] \
  || fail "this is a $DEPLOY_ENVIRONMENT server, but VITE_SUPABASE_URL is not the $DEPLOY_ENVIRONMENT Supabase project ($expected)."

cd "$REPO"
[ -z "$(git status --porcelain)" ] || fail "$REPO has local changes. It must be an untouched checkout: see 'git status' there."
git fetch --quiet --prune --tags origin
commit="$(git rev-parse --verify --quiet "$REF^{commit}")" || fail "no such commit: $REF"
git checkout --quiet --detach "$commit"
release="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short "$commit")"
echo "deploy: building $(git log -1 --format='%h %s' "$commit") as $release ($DEPLOY_ENVIRONMENT)"

npm ci --no-audit --no-fund
# Stops by itself if required content is missing, the ordering link is a placeholder, or the
# application form is switched on without a privacy policy.
npm run build

# Checks on what was built, before anyone can see it.
[ -f dist/index.html ] || fail "the build produced no dist/index.html."
[ -f dist/404.html ] || fail "the build produced no dist/404.html."
if grep -rlq 'class="sample-banner"' dist --include='*.html'; then
  fail "the build contains the SAMPLE banner. Nothing was published."
fi
if grep -qx 'Disallow: /' dist/robots.txt; then
  fail "robots.txt blocks the whole site, which means a sample build. Nothing was published."
fi
grep -q "data-menu-url=\"$expected/functions/v1/public-menu" dist/menu/index.html \
  || fail "the menu page does not point at $expected. Nothing was published."

mkdir "$RELEASES/$release"
cp -a dist/. "$RELEASES/$release/"
previous="$(live_release)"

# carry-assets: begin
# Keep the previous release's hashed files for one more release, so a page a visitor opened
# just before this deployment can still load its scripts and fonts.
#
# Only the files that release BUILT are carried, not the ones it was itself carrying from
# the release before it: otherwise every release would hold the files of all the releases
# there have ever been. Which files a release built is noted here, outside the served
# folder, before anything is carried into it.
mkdir -p "$OWN_ASSETS"
if [ -d "$RELEASES/$release/assets" ]; then
  ls -1 "$RELEASES/$release/assets" > "$OWN_ASSETS/$release"
else
  : > "$OWN_ASSETS/$release"
fi
if [ -n "$previous" ] && [ -d "$RELEASES/$previous/assets" ] && [ -d "$RELEASES/$release/assets" ]; then
  if [ -f "$OWN_ASSETS/$previous" ]; then
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      [ -f "$RELEASES/$previous/assets/$name" ] || continue
      [ -e "$RELEASES/$release/assets/$name" ] || cp -a "$RELEASES/$previous/assets/$name" "$RELEASES/$release/assets/"
    done < "$OWN_ASSETS/$previous"
  else
    # A release from before these notes were kept: nothing says which files it built, so
    # all of them are carried, this once.
    for file in "$RELEASES/$previous/assets/"*; do
      [ -f "$file" ] || continue
      [ -e "$RELEASES/$release/assets/$(basename "$file")" ] || cp -a "$file" "$RELEASES/$release/assets/"
    done
  fi
fi
# carry-assets: end
# Nginx reads these as its own user.
chmod -R a+rX "$RELEASES/$release"

switch_to "$release"
echo "deploy: $release is live."

# Old releases are removed, the live one and the newest $KEEP_RELEASES never.
ls -1 "$RELEASES" | sort | head -n "-$KEEP_RELEASES" | while read -r old; do
  [ "$old" = "$release" ] || { rm -rf "${RELEASES:?}/$old"; rm -f "${OWN_ASSETS:?}/$old"; }
done

echo "deploy: now run the outside check from a developer machine:"
echo "          SITE_URL=<this site's address> EXPECT_SUPABASE_URL=$expected npm run verify:site"
echo "        To undo this deployment: $0 --rollback"
exit 0

}
