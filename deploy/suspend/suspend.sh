#!/usr/bin/env bash
# Suspends or restores the website on the production server (the Hostinger VPS).
# Run it ON the server, as root, from the folder that holds this script and its two files:
#
#   sudo bash suspend.sh on       every address answers 503 with the "Payment needed" page
#   sudo bash suspend.sh off      the normal site is back, exactly as it was
#   sudo bash suspend.sh status   which of the two is live
#
# Only the Nginx site link is swapped. The live release (/var/www/<domain>/current), the
# releases and the Supabase backend are not touched. If Nginx rejects the new configuration,
# the previous link is put back and nothing changes for visitors.
set -euo pipefail

DOMAIN="luzenarestaurant.com"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AVAILABLE="/etc/nginx/sites-available"
ENABLED="/etc/nginx/sites-enabled"
NORMAL_CONF="$AVAILABLE/$DOMAIN.conf"
SUSPENDED_CONF="$AVAILABLE/$DOMAIN.suspended.conf"
NORMAL_LINK="$ENABLED/$DOMAIN.conf"
SUSPENDED_LINK="$ENABLED/$DOMAIN.suspended.conf"
PAGE_DIR="/var/www/$DOMAIN/suspended"

fail() { echo "suspend: $*" >&2; exit 1; }

state() {
  if [ -L "$SUSPENDED_LINK" ] && [ ! -e "$NORMAL_LINK" ]; then echo suspended
  elif [ -L "$NORMAL_LINK" ] && [ ! -e "$SUSPENDED_LINK" ]; then echo live
  else echo unknown
  fi
}

# Swaps one link for the other; puts the old one back if Nginx refuses the result.
swap() {
  local from_link="$1" to_target="$2" to_link="$3"
  rm "$from_link"
  ln -s "$to_target" "$to_link"
  if ! nginx -t; then
    rm "$to_link"
    ln -s "$( [ "$from_link" = "$NORMAL_LINK" ] && echo "$NORMAL_CONF" || echo "$SUSPENDED_CONF" )" "$from_link"
    fail "Nginx rejected the configuration. The previous one was put back; nothing changed."
  fi
  systemctl reload nginx
}

[ "$(id -u)" = 0 ] || fail "run it with sudo."
command -v nginx >/dev/null || fail "nginx is not installed here. Is this the right server?"

case "${1:-}" in
  on)
    [ "$(state)" != suspended ] || { echo "suspend: already suspended."; exit 0; }
    [ "$(state)" = live ] || fail "$NORMAL_LINK is not the only link for $DOMAIN in $ENABLED. Check 'ls -la $ENABLED'."
    [ -f "$HERE/payment-needed.html" ] && [ -f "$HERE/$DOMAIN.suspended.conf" ] \
      || fail "payment-needed.html and $DOMAIN.suspended.conf must be next to this script."
    install -d -m 755 "$PAGE_DIR"
    install -m 644 "$HERE/payment-needed.html" "$PAGE_DIR/payment-needed.html"
    install -m 644 "$HERE/$DOMAIN.suspended.conf" "$SUSPENDED_CONF"
    swap "$NORMAL_LINK" "$SUSPENDED_CONF" "$SUSPENDED_LINK"
    echo "suspend: SUSPENDED. https://$DOMAIN now shows \"Payment needed\" (503)."
    ;;
  off)
    [ "$(state)" != live ] || { echo "suspend: the site is already live."; exit 0; }
    [ "$(state)" = suspended ] || fail "unexpected links for $DOMAIN in $ENABLED. Check 'ls -la $ENABLED'."
    [ -f "$NORMAL_CONF" ] || fail "$NORMAL_CONF is missing."
    swap "$SUSPENDED_LINK" "$NORMAL_CONF" "$NORMAL_LINK"
    echo "suspend: RESTORED. https://$DOMAIN is serving the normal site again."
    ;;
  status)
    echo "suspend: $(state)"
    ;;
  *)
    fail "usage: sudo bash suspend.sh on|off|status"
    ;;
esac
