#!/bin/sh
# Lab session 3 (M0.07), rows B01, B06 and B07 cold after a reboot, on Linux.
#
# A supervisor that is not Node: it times the installed launcher directly, so nothing warms the
# Node runtime before the timed start. Run it right after the reboot, over SSH,
# before anything else starts the lab install's Node:
#
#   sh cold-start.sh <lab install root> <results .jsonl> <label> [offline|online|shim|all] [state]
#
# offline  bin/ttasks mcp with the service not running: spawn to the reply line of an MCP
#          initialize (the offline first launch after a reboot). Refuses if the service runs.
# online   the same with the service running (the runtime is then already warm from the service).
# shim     mints a ticket through bin/ttasks ticket (Node), then times bin/ttasks shim from spawn to
#          its claim (the service's claim event). Needs the service.
# all      offline, then starts the service if it is not running, then online and shim, each
#          labelled. It stops the service again if it started it.
#
# The clock stops at the reply line, read with the shell's own `read`, so no process starts
# between the reply and the second clock reading. Then the script asks the same bridge for
# `status` and keeps both reply lines.
#
# Validation, after the last timed launch. The replies are parsed as JSON and checked by
# structure: the initialize reply is a JSON-RPC 2.0 response with the number 0 as its id, a
# result object with protocolVersion 2025-11-25 and a serverInfo object with a name, and no
# error; the status reply is a response with the number 1 as its id and a text content item. It
# is the service's answer when the text is a JSON object naming the instance in service.json, and
# the bridge's own offline answer when the result is an error whose text says "not running".
# POSIX sh cannot parse JSON, and the only JSON parser certainly present is the install's own
# Node, which is the thing being measured. So the script validates with it only when every timed
# launch of the run is over: it records each measurement when the run ends (also on an error or a
# signal), not when it is taken. Never validate, or start anything else from the install's Node,
# before the timed launches of a reboot: that would warm the runtime the cold numbers measure.
# When the validator cannot run, the line says "not validated, not counted".
#
# A measurement counts (ok true) only when it is valid and the answer is of the kind its metric
# needs: an offline answer to `online` is recorded as "offline answer, not counted", an online
# answer to `offline` likewise.
#
# "The service runs" means more than a live PID: service.json names a process whose arguments are
# the runtime, its options, this install's versions/<v>/lib/ttasks.mjs and then `service`, and
# which started no later than service.json was written. After a reboot a stale service.json may
# name any process. None of these checks runs Node.
#
# Every wait is bounded (COLD_START_LIMIT_S, default 20 s). On exit, on an error and on INT, TERM
# or HUP the script stops every process it started (bridge, watchdog, ticket call, shim, service),
# waits for them, and deletes its temporary folder; if something does not stop, it keeps the
# folder and names what is left. COLD_START_FAIL_AT=service-started is a test hook: it fails on
# purpose right after starting the service.
#
# POSIX sh plus GNU coreutils (date +%s%N, readlink -f, stat -c, timeout), mkfifo, sed, awk, grep
# and /proc. Each measurement appends one JSON line to the results file when the run ends.
set -u
root=$1
out=$2
label=$3
metric=${4:-all}
state=${5:-$1/state/service}
limit=${COLD_START_LIMIT_S:-20}
tasks=$root/bin/ttasks
init='{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"ttasks-cold-start","version":"1"}}}'
status_call='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"status","arguments":{}}}'
# The validator: node -e "$validator" <initialize reply file> <status reply file> <instance or "">
# prints "invalid", "valid service", "valid offline" or "valid unknown". Run only after the timed
# launches (see "Validation" above).
validator='
const fs = process.getBuiltinModule("node:fs");
const [initFile, statusFile, instance] = process.argv.slice(-3);
const line = (f) => fs.readFileSync(f, "utf8").replace(/\r?\n$/, "");
const parse = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
const obj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const response = (m, id) =>
  obj(m) && m.jsonrpc === "2.0" && m.id === id && own(m, "result") && !own(m, "error") && obj(m.result);
const init = parse(line(initFile));
let verdict = "invalid";
if (response(init, 0) && init.result.protocolVersion === "2025-11-25" && obj(init.result.serverInfo) &&
    typeof init.result.serverInfo.name === "string" && init.result.serverInfo.name !== "") {
  verdict = "valid unknown";
  const said = parse(line(statusFile));
  const item = response(said, 1) && Array.isArray(said.result.content) ? said.result.content[0] : undefined;
  if (obj(item) && item.type === "text" && typeof item.text === "string") {
    const text = parse(item.text);
    if (instance !== "" && said.result.isError !== true && obj(text) && text.instance === instance) {
      verdict = "valid service";
    } else if (said.result.isError === true && item.text.includes("not running")) {
      verdict = "valid offline";
    }
  }
}
process.stdout.write(verdict + "\n");
'

# Load date, awk and sed once, so their first start is not inside a timed interval.
date +%s%N >/dev/null
awk 'BEGIN { exit 0 }'
sed -n 1p /dev/null

warn() { printf '%s\n' "$*" >&2; }
die() {
  warn "cold-start: $*"
  exit 1
}

realroot=$(readlink -f "$root") || die "no install at $root"
mkdir -p "$root/state" && tmp=$(mktemp -d "$root/state/cold.XXXXXX") || exit 1

# Processes this script started and has not seen end. Each is registered as soon as it exists.
child=
watchdog=
bounded=
shim=
svc=
started=
# Measurements taken and not yet recorded: $tmp/m<n>.line (a finished record) or $tmp/m<n>.meta
# with $tmp/m<n>.init and $tmp/m<n>.status (a bridge measurement, recorded after validation).
pending=0

# Alive and not a zombie (a child that ended but was not waited for still answers kill -0).
alive() {
  st=$(sed -n 's/^State:[[:space:]]*\(.\).*/\1/p' "/proc/$1/status" 2>/dev/null)
  [ -n "$st" ] && [ "$st" != Z ]
}
wait_exit() { # pid seconds: true once it ended
  i=0
  while alive "$1"; do
    i=$((i + 1))
    [ "$i" -gt $(($2 * 10)) ] && return 1
    sleep 0.1
  done
  return 0
}
stop_pid() { # pid: TERM, then KILL, each bounded. True once it ended.
  [ -n "$1" ] || return 0
  if alive "$1"; then
    kill -TERM "$1" 2>/dev/null
    if ! wait_exit "$1" 5; then
      kill -KILL "$1" 2>/dev/null
      wait_exit "$1" 2 || return 1
    fi
  fi
  wait "$1" 2>/dev/null
  return 0
}

cleanup() {
  code=$?
  trap - EXIT
  trap '' INT TERM HUP
  exec 3>&- 4>&-
  left=
  for p in $watchdog $child $bounded $shim; do
    stop_pid "$p" || left="$left $p"
  done
  if [ -n "$started" ]; then
    # The service this script started: when it is ready, ask it to stop and give it 15 s. Then
    # make sure, by its PID.
    if running && [ "$service_pid" = "$svc" ]; then
      "$tasks" call --state "$state" service/shutdown >/dev/null 2>&1 </dev/null &
      call=$!
      if wait_exit "$call" 15; then
        wait "$call" 2>/dev/null && wait_exit "$svc" 15
      else
        stop_pid "$call" || left="$left $call"
      fi
    fi
    stop_pid "$svc" || left="$left $svc"
  fi
  # Every timed launch of this run is over: validate and record what was measured.
  finalize
  if [ -n "$left" ]; then
    warn "cold-start: not stopped:$left. Kept $tmp for diagnosis."
    [ "$code" -eq 0 ] && code=1
  else
    rm -rf "$tmp"
  fi
  exit "$code"
}

# Validates the bridge measurements and writes every measurement of the run to the results file,
# in the order taken. Called by cleanup, so only after every timed launch of the run.
finalize() {
  i=1
  while [ "$i" -le "$pending" ]; do
    if [ -f "$tmp/m$i.line" ]; then
      tee -a "$out" <"$tmp/m$i.line"
    elif read -r want ms was up inst <"$tmp/m$i.meta"; then
      [ "$inst" = - ] && inst=
      verdict=$(validate "$tmp/m$i.init" "$tmp/m$i.status" "$inst")
      ok=false
      case $verdict in
        invalid) answer=none ;;
        "valid offline") answer=offline ;;
        "valid service") answer=service ;;
        "valid unknown") answer=unknown ;;
        *) answer=unvalidated ;;
      esac
      case $want/$answer in
        */none) note="no valid initialize reply within $limit s, not counted" ;;
        */unvalidated) note="not validated (the validator did not run), not counted" ;;
        offline/offline) ok=true note="offline first launch" ;;
        online/service) ok=true note="runtime already warmed by the service" ;;
        */offline) note="offline answer, not counted" ;;
        */service) note="online answer, not counted" ;;
        *) note="the answer named no expected service, not counted" ;;
      esac
      json_line "forwarder_$want" "$ms" "$ok" "$was" "$answer" "$note" "$up" | tee -a "$out"
    fi
    i=$((i + 1))
  done
  pending=0
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

uptime_s() { awk '{ printf "%d", $1 }' /proc/uptime; }

# The service's PID and instance from service.json.
read_service() {
  service_pid=
  instance=
  [ -f "$state/service.json" ] || return 1
  service_pid=$(sed -n 's/.*"pid": *\([0-9][0-9]*\).*/\1/p' "$state/service.json" | head -n 1)
  instance=$(sed -n 's/.*"instance": *"\([A-Za-z0-9_-]*\)".*/\1/p' "$state/service.json" | head -n 1)
  [ -n "$service_pid" ] && [ -n "$instance" ]
}

# service.json names this install's live service, not just a live PID.
running() {
  read_service || return 1
  alive "$service_pid" || return 1
  # The arguments after the runtime and its options (--...): the entry, then the command.
  args=$(tr '\0' '\n' <"/proc/$service_pid/cmdline" 2>/dev/null |
    awk 'NR == 1 { next } e == "" && /^--/ { next } e == "" { e = $0; next } { print e; print $0; exit }')
  entry=$(printf '%s\n' "$args" | sed -n 1p)
  [ "$(printf '%s\n' "$args" | sed -n 2p)" = service ] || return 1
  # The entry is versions/<v>/lib/ttasks.mjs of this install, <v> one folder name.
  v=${entry#"$realroot"/versions/}
  v=${v%/lib/ttasks.mjs}
  case $v in '' | */*) return 1 ;; esac
  [ "$entry" = "$realroot/versions/$v/lib/ttasks.mjs" ] || return 1
  # A reused PID started after service.json was written.
  startup=$(awk -v tck="$(getconf CLK_TCK)" -v bt="$(awk '/^btime/ { print $2 }' /proc/stat)" \
    '{ sub(/.*\) /, ""); print int(bt + $20 / tck) }' "/proc/$service_pid/stat" 2>/dev/null)
  written=$(stat -c %Y "$state/service.json" 2>/dev/null)
  [ -n "$startup" ] && [ -n "$written" ] && [ "$startup" -le $((written + 1)) ]
}

json_line() { # metric ms ok running answer note uptime
  printf '{"metric":"%s","label":"%s","ms":%s,"ok":%s,"uptime_s":%s,"service_running_before":%s,"answer":"%s","note":"%s"}\n' \
    "$1" "$label" "$2" "$3" "$7" "$4" "$5" "$6"
}

record() { # metric ms ok running answer note: a finished measurement, written when the run ends
  n=$((pending + 1))
  json_line "$1" "$2" "$3" "$4" "$5" "$6" "$(uptime_s)" >"$tmp/m$n.line"
  pending=$n
}

# Kills the bridge after `limit` seconds and writes an empty line to the reply FIFO, so a read
# never waits longer than that.
start_watchdog() {
  (
    exec 3>&-
    trap 'kill "$sp" 2>/dev/null; exit 0' TERM
    sleep "$limit" &
    sp=$!
    wait "$sp"
    if [ -f "$tmp/child.pid" ]; then
      read -r cp <"$tmp/child.pid" && kill -KILL "$cp" 2>/dev/null
    fi
    printf '\n' >&4
  ) &
  watchdog=$!
}

measure_bridge() { # offline|online
  want=$1
  if running; then was=true; else was=false; fi
  if [ "$want" = offline ] && [ "$was" = true ]; then die "offline needs the service stopped"; fi
  if [ "$want" = online ] && [ "$was" = false ]; then
    warn "cold-start: no running service of this install found. Measuring anyway: the answer decides the label."
  fi
  read_service || instance=
  rm -f "$tmp/in" "$tmp/out" "$tmp/child.pid"
  mkfifo "$tmp/in" "$tmp/out" || die "mkfifo failed"
  # Both ends held read-write by this shell, so no open blocks and EOF never ends a read early.
  exec 3<>"$tmp/in" 4<>"$tmp/out"
  start_watchdog
  t0=$(date +%s%N)
  "$tasks" mcp --state "$state" <"$tmp/in" >"$tmp/out" 2>"$tmp/bridge.err" 3>&- 4>&- &
  child=$!
  printf '%s\n' "$child" >"$tmp/child.pid"
  printf '%s\n' "$init" >&3
  IFS= read -r reply <&4 || reply=
  t1=$(date +%s%N)
  up=$(uptime_s)
  # After the clock: ask the same bridge which service answers. Both replies are kept and checked
  # when the run ends (see "Validation" above).
  said=
  if [ -n "$reply" ]; then
    printf '%s\n' "$status_call" >&3
    IFS= read -r said <&4 || said=
  fi
  # A bridge that answered ends by itself when its stdin closes. One that did not is stopped now.
  exec 3>&-
  if [ -n "$reply" ]; then wait_exit "$child" 10; fi
  stop_pid "$child" || die "the bridge $child did not end"
  child=
  stop_pid "$watchdog"
  watchdog=
  exec 4>&-
  rm -f "$tmp/in" "$tmp/out" "$tmp/child.pid"
  ms=$(awk -v a="$t0" -v b="$t1" 'BEGIN { printf "%.1f", (b - a) / 1000000 }')
  n=$((pending + 1))
  printf '%s\n' "$reply" >"$tmp/m$n.init"
  printf '%s\n' "$said" >"$tmp/m$n.status"
  printf '%s %s %s %s %s\n' "$want" "$ms" "$was" "$up" "${instance:--}" >"$tmp/m$n.meta"
  pending=$n
}

# The validator's verdict on one bridge measurement: initialize reply file, status reply file,
# instance. Empty output when the validator could not run.
validate() {
  if [ "$(cat "$1")" = "" ]; then
    echo invalid
    return
  fi
  runtime=$(readlink -f "$root/current" 2>/dev/null)/runtime/node
  timeout -k 2 "$limit" "$runtime" -e "$validator" "$1" "$2" "$3" </dev/null 2>>"$tmp/validate.err"
}

run_bounded() { # outfile command...: the command in the background, killed at the limit
  outf=$1
  shift
  "$@" >"$outf" 2>>"$tmp/bounded.err" </dev/null &
  bounded=$!
  if wait_exit "$bounded" "$limit"; then
    wait "$bounded"
    rc=$?
  else
    stop_pid "$bounded"
    rc=124
  fi
  bounded=
  return $rc
}

measure_shim() {
  running || die "shim needs the service running"
  folder=$root/state/cold-folder
  mkdir -p "$folder"
  node=$(readlink -f "$root/current")/runtime/node
  run_bounded "$tmp/ticket.json" "$tasks" ticket --state "$state" --cwd "$folder" -- "$node" -e 0 ||
    die "the ticket call failed or did not finish within $limit s"
  ticket=$(sed -n 's/.*"ticket": *"\([^"]*\)".*/\1/p' "$tmp/ticket.json")
  [ -n "$ticket" ] || die "the ticket call gave no ticket"
  tag=$(printf '%s' "$ticket" | sha256sum | cut -c1-12)
  t0=$(date +%s%N)
  "$tasks" shim --state "$state" "$ticket" </dev/null >/dev/null 2>&1 &
  shim=$!
  if ! wait_exit "$shim" "$limit"; then
    stop_pid "$shim"
    shim=
    record shim_claim null false true none "the shim did not finish within $limit s, not counted"
    return
  fi
  wait "$shim"
  shim=
  claim=$(grep '"kind":"claim"' "$state/events.jsonl" | grep "\"ticket\":\"$tag\"" | tail -n 1 | sed -n 's/^{"t":\([0-9.]*\),.*/\1/p')
  if [ -z "$claim" ]; then
    record shim_claim null false true none "no claim event, not counted"
    return
  fi
  ms=$(awk -v a="$t0" -v c="$claim" 'BEGIN { printf "%.1f", c - a / 1000000 }')
  record shim_claim "$ms" true true service "runtime already warmed by the service and the ticket call"
}

start_service() {
  "$tasks" service --state "$state" >"$tmp/service.out" 2>&1 </dev/null &
  svc=$! # the launcher execs Node, so this is the service's own PID
  started=1
  [ "${COLD_START_FAIL_AT:-}" = service-started ] && die "failing on purpose after starting the service (test hook)"
  i=0
  until running && [ "$service_pid" = "$svc" ]; do
    alive "$svc" || die "the service ended before it was ready"
    i=$((i + 1))
    [ "$i" -gt $((limit * 10)) ] && die "the service did not start within $limit s"
    sleep 0.1
  done
}

case $metric in
  offline) measure_bridge offline ;;
  online) measure_bridge online ;;
  shim) measure_shim ;;
  all)
    if running; then
      warn "cold-start: the service runs already, so there is no offline measurement."
    else
      measure_bridge offline
      start_service
    fi
    measure_bridge online
    measure_shim
    ;;
  *)
    warn "metric is offline, online, shim or all"
    exit 64
    ;;
esac
