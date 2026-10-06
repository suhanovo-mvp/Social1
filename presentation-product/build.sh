#!/bin/sh
# Собирает .dc.html слайдов из общей шапки (_style.frag) и тел слайдов (b*.frag).
set -e
for body in b*.frag; do
  n=${body#b}; n=${n%.frag}
  case "$n" in 01) out=Main.dc.html ;; *) out=S$n.dc.html ;; esac
  {
    printf '%s\n' '<!doctype html>' '<html>' '<head>' '  <meta charset="utf-8">' \
      '  <script src="./support.js"></script>' '</head>' '<body>' '<x-dc>'
    cat _style.frag
    cat "$body"
    printf '%s\n' '</x-dc>' '</body>' '</html>'
  } > "$out"
  echo "  $body -> $out"
done
