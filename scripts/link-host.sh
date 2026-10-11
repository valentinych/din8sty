#!/bin/sh
# Maps din8sty.panenka.games → 127.0.0.1 (requires admin once).
set -e
if grep -q 'din8sty.panenka.games' /etc/hosts; then
  echo "OK: din8sty.panenka.games already in /etc/hosts"
  grep 'din8sty.panenka.games' /etc/hosts
  exit 0
fi
echo "Adding 127.0.0.1 din8sty.panenka.games to /etc/hosts…"
osascript -e 'do shell script "echo \"127.0.0.1 din8sty.panenka.games\" >> /etc/hosts" with administrator privileges'
echo "Done."
grep 'din8sty.panenka.games' /etc/hosts
