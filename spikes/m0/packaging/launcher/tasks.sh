#!/bin/sh
# Tasks launcher. Generated at build time. Do not edit.
self=$(readlink -f -- "$0") || exit 70
root=${self%/bin/tasks}                      # .../versions/<v>
home=${root%/versions/*}                     # the install root
[ -f "$home/home.marker" ] && export TASKS_HOME="$home"
unset NODE_OPTIONS NODE_PATH
exec "$root/runtime/node" --report-exclude-env "$root/lib/tasks.mjs" "$@"
