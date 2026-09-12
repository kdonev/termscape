/**
 * The installers a joining machine downloads and runs.
 *
 * They are generated rather than shipped as files so the hub's own origin and
 * a freshly minted single-use token are baked in — the person running this has
 * nothing to configure and nothing to paste twice.
 *
 * Both scripts follow the same order, and it matters: work out what is missing
 * first, and say precisely what is happening *before* changing anything. The
 * SSH deploy path could only report a failure as a wall of build output in a
 * tooltip; here the message lands in the terminal of the person standing at
 * the keyboard.
 *
 * They are also deliberately chatty. Two steps take a minute or more — pulling
 * ~30MB of Node, and an `npm install` that may compile native modules — and a
 * terminal that prints nothing for that long is indistinguishable from one
 * that has hung. Every long step therefore says what it is about to do, ticks
 * while it runs, and reports how long it took.
 *
 * When Node is missing or too old, a private copy is fetched into
 * `~/.termscape/node` rather than installed system-wide. That is deliberate:
 * it needs no administrator rights, no package manager, and no PATH surgery
 * that a fresh shell would have to pick up; and uninstalling is deleting one
 * directory. The download is checksum-verified against nodejs.org's own
 * SHASUMS256.txt, because this is a binary we are about to execute.
 */

/** Shell-safe: our tokens are base64url and origins are URLs, but be explicit. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The Node line we fetch from. 22 is the minimum the hub supports. */
const NODE_DIST = 'https://nodejs.org/dist/latest-v22.x';

export function joinScriptPosix(origin: string, token: string): string {
  return `#!/bin/sh
# Joins this machine to the Termscape canvas at ${origin}.
set -eu

HUB_URL=${sq(origin)}
JOIN_TOKEN=${sq(token)}
HOME_DIR="\${TERMSCAPE_HOME:-$HOME/.termscape}"
NODE_DIST=${sq(NODE_DIST)}

say()  { printf '%s\\n' "$*"; }
note() { printf '       %s\\n' "$*"; }
step() { printf '\\n[%s] %s\\n' "$1" "$2"; }
fail() { printf '\\n%s\\n' "$*" >&2; exit 1; }

now()   { date +%s; }
since() { printf '%ss' "$(( $(now) - $1 ))"; }
human() {
  if [ "$1" -ge 1048576 ]; then printf '%s MB' "$(( $1 / 1048576 ))"
  elif [ "$1" -ge 1024 ]; then printf '%s KB' "$(( $1 / 1024 ))"
  else printf '%s B' "$1"; fi
}
size_of() { wc -c < "$1" 2>/dev/null | tr -d ' ' || echo 0; }

# $1 url, $2 destination, $3 "quiet" to suppress the progress bar
fetch() {
  if command -v curl >/dev/null 2>&1; then
    if [ "\${3:-}" = quiet ]; then curl -fsSL "$1" -o "$2"; else curl -f -# -L "$1" -o "$2"; fi
  elif command -v wget >/dev/null 2>&1; then
    if [ "\${3:-}" = quiet ]; then wget -qO "$2" "$1"; else wget -O "$2" "$1"; fi
  else
    fail "Neither curl nor wget is available; cannot download anything."
  fi
}

fetch_stdout() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else echo ''; fi
}

# Run a long command in the background, ticking so the terminal never looks
# hung. A finished child stays a zombie until it is reaped, so kill -0 would
# spin forever; a marker file is the reliable POSIX signal that it is done.
run_ticking() {
  LABEL="$1"; shift
  RC_FILE="$HOME_DIR/.step.rc"
  rm -f "$RC_FILE"
  ( "$@" >>"$HOME_DIR/install.log" 2>&1; echo $? >"$RC_FILE" ) &
  T0=$(now)
  printf '       %s ' "$LABEL"
  while [ ! -f "$RC_FILE" ]; do
    printf '.'
    sleep 2
  done
  RC=$(cat "$RC_FILE"); rm -f "$RC_FILE"
  printf ' %s\\n' "$(since "$T0")"
  return "$RC"
}

# A hub from an earlier join is still running and still holds its own install
# open, so it has to go before those files can be replaced. It also stops this
# machine appearing twice on the canvas.
stop_running_hub() {
  OLD_PID=""
  [ -f "$HOME_DIR/hub.pid" ] && OLD_PID=$(cat "$HOME_DIR/hub.pid" 2>/dev/null || true)
  # A hub predating the pid file, or one whose file was lost.
  if [ -z "$OLD_PID" ] && command -v pgrep >/dev/null 2>&1; then
    OLD_PID=$(pgrep -f "$HOME_DIR/hub/dist/cli.js" 2>/dev/null | head -1 || true)
    [ -n "$OLD_PID" ] || OLD_PID=$(pgrep -f "TERMSCAPE_HOME=$HOME_DIR" 2>/dev/null | head -1 || true)
  fi
  [ -n "$OLD_PID" ] || return 0
  kill -0 "$OLD_PID" 2>/dev/null || return 0

  note "stopping the hub already running here (pid $OLD_PID)"
  kill "$OLD_PID" 2>/dev/null || true
  i=0
  while [ $i -lt 40 ]; do
    kill -0 "$OLD_PID" 2>/dev/null || { rm -f "$HOME_DIR/hub.pid"; return 0; }
    i=$((i + 1))
    sleep 0.25
  done
  kill -9 "$OLD_PID" 2>/dev/null || true
  sleep 1
  rm -f "$HOME_DIR/hub.pid"
}

mkdir -p "$HOME_DIR"
say ""
say "Termscape - joining $HUB_URL"

# --- node -------------------------------------------------------------------
NODE_BIN=node
NPM_BIN=npm

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

use_private_node() {
  NODE_BIN="$HOME_DIR/node/bin/node"
  NPM_BIN="$HOME_DIR/node/bin/npm"
  PATH="$HOME_DIR/node/bin:$PATH"
  export PATH
}

install_node() {
  case "$(uname -s)" in
    Darwin) OS=darwin ;;
    Linux)  OS=linux ;;
    *)      fail "Unsupported platform $(uname -s); install Node 22 yourself and re-run." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  ARCH=x64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *)             fail "Unsupported CPU $(uname -m); install Node 22 yourself and re-run." ;;
  esac

  note "looking up the latest Node 22 for \${OS}-\${ARCH}"
  SUMS=$(fetch_stdout "$NODE_DIST/SHASUMS256.txt") \\
    || fail "Could not reach $NODE_DIST - check this machine's internet access."

  LINE=$(printf '%s\\n' "$SUMS" | grep -- "-\${OS}-\${ARCH}\\.tar\\.gz\$" | head -1)
  [ -n "$LINE" ] || fail "nodejs.org has no \${OS}-\${ARCH} build on the v22 line."
  WANT_SHA=$(printf '%s' "$LINE" | awk '{print $1}')
  TARBALL=$(printf '%s' "$LINE" | awk '{print $2}')

  note "downloading $TARBALL (about 30 MB)"
  T0=$(now)
  fetch "$NODE_DIST/$TARBALL" "$HOME_DIR/$TARBALL"
  note "downloaded $(human "$(size_of "$HOME_DIR/$TARBALL")") in $(since "$T0")"

  # We are about to execute this, so verify it rather than trusting the pipe.
  printf '       verifying checksum ... '
  GOT_SHA=$(sha256_of "$HOME_DIR/$TARBALL")
  if [ -z "$GOT_SHA" ]; then
    say "skipped (no sha256 tool on this machine)"
  elif [ "$GOT_SHA" != "$WANT_SHA" ]; then
    say "FAILED"
    rm -f "$HOME_DIR/$TARBALL"
    fail "Checksum mismatch on $TARBALL. Refusing to run it."
  else
    say "ok"
  fi

  note "unpacking into $HOME_DIR/node"
  rm -rf "$HOME_DIR/node"
  mkdir -p "$HOME_DIR/node"
  tar xzf "$HOME_DIR/$TARBALL" -C "$HOME_DIR/node" --strip-components=1
  rm -f "$HOME_DIR/$TARBALL"

  use_private_node
  note "installed $("$NODE_BIN" --version)"
}

step 1/4 "Node 22"
if [ -x "$HOME_DIR/node/bin/node" ] && [ "$(node_major "$HOME_DIR/node/bin/node")" -ge 22 ]; then
  use_private_node
  note "$("$NODE_BIN" --version) already here (private copy)"
elif command -v node >/dev/null 2>&1 && [ "$(node_major node)" -ge 22 ]; then
  note "$(node --version) already on this machine"
elif command -v node >/dev/null 2>&1; then
  note "$(node --version) is older than 22; fetching a private copy"
  install_node
else
  note "not installed; fetching a private copy"
  install_node
fi

# --- the hub ----------------------------------------------------------------
step 2/4 "hub package"
note "downloading from $HUB_URL"
fetch "$HUB_URL/hub.tgz" "$HOME_DIR/hub.tgz" quiet
note "got $(human "$(size_of "$HOME_DIR/hub.tgz")")"

stop_running_hub

# The dependency tree is the slowest thing here to rebuild and the tarball
# never carries one, so it is moved aside rather than deleted along with the
# rest of the install. Whether it can be kept is step 3's question.
KEPT_MODULES="$HOME_DIR/node_modules.kept"
rm -rf "$KEPT_MODULES"
if [ -d "$HOME_DIR/hub/node_modules" ]; then
  mv "$HOME_DIR/hub/node_modules" "$KEPT_MODULES"
fi

rm -rf "$HOME_DIR/hub"
mkdir -p "$HOME_DIR/hub"
tar xzf "$HOME_DIR/hub.tgz" -C "$HOME_DIR/hub" --strip-components=1
if [ -d "$KEPT_MODULES" ]; then
  mv "$KEPT_MODULES" "$HOME_DIR/hub/node_modules"
fi
note "unpacked into $HOME_DIR/hub"

# --- install ----------------------------------------------------------------
step 3/4 "dependencies"
note "full log: $HOME_DIR/install.log"
cd "$HOME_DIR/hub"
: >"$HOME_DIR/install.log"

# What the tree already here would have to match to be worth keeping: the
# fingerprint the tarball shipped, plus the two things it cannot know - the
# Node ABI these modules were built against, and the platform.
STAMP_FILE="$HOME_DIR/deps.stamp"
FINGERPRINT=$(cat "$HOME_DIR/hub/deps.fingerprint" 2>/dev/null || echo none)
NODE_ABI=$("$NODE_BIN" -p 'process.versions.node.split(".")[0] + "-" + process.platform + "-" + process.arch')
WANT_STAMP="$FINGERPRINT-$NODE_ABI"

# The stamp claims this tree still works. Confirming it does costs one Node
# start, and is the whole difference between an optimisation and a machine
# that joins with a hub unable to load its own modules.
#
# The confirmation is an import of the hub's own entry point rather than a
# require of the two native modules. It links the whole graph - node-pty and
# better-sqlite3 among it - so it still catches a module built for the wrong
# ABI, and it additionally catches the one thing a require of those two never
# could: a stale @termscape/protocol, which fails at link time with "does not
# provide an export named X". Importing it is side-effect free and leaves no
# handles open; the hub only starts from cli.js.
deps_reusable() {
  [ -d "$HOME_DIR/hub/node_modules" ] || return 1
  [ "$(cat "$STAMP_FILE" 2>/dev/null || true)" = "$WANT_STAMP" ] || return 1
  "$NODE_BIN" -e "import('./dist/hub.js').catch(e => { console.error(e); process.exit(1); })" \\
    >>"$HOME_DIR/install.log" 2>&1
}

install_deps() {
  note "this is the slow part - a minute or two on a first run"
  # A half-finished tree must not inherit the last run's stamp.
  rm -f "$STAMP_FILE"

  # The vendored workspace package has to go before npm runs.
  #
  # Every other dependency is a registry package whose version moves when its
  # code does, so npm reinstalls it on its own. @termscape/protocol is a
  # file: tarball whose version stands still across builds while its code
  # changes underneath, and npm reads the copy already in node_modules as
  # satisfying the spec and leaves it there - so a hub built against a new
  # protocol was installed beside last build's copy, and died on its first
  # import. Deleting it is what makes npm extract the tarball again; the
  # expensive native modules beside it are untouched.
  rm -rf "$HOME_DIR/hub/node_modules/@termscape"

  # Prebuilt binaries first: node-pty and better-sqlite3 publish them for the
  # mainstream platforms, and downloading one beats compiling it every time.
  if run_ticking "installing" "$NPM_BIN" install --omit=dev --no-audit --no-fund; then
    return 0
  fi
  note "no prebuilt binaries for this platform; compiling instead"
  if run_ticking "compiling" "$NPM_BIN" install --omit=dev --no-audit --no-fund --build-from-source; then
    return 0
  fi

  tail -20 "$HOME_DIR/install.log" >&2
  case "$(uname -s)" in
    Darwin) TOOLCHAIN="xcode-select --install" ;;
    *)      TOOLCHAIN="sudo apt install build-essential python3   # or your distro's equivalent" ;;
  esac
  fail \\
"Could not install node-pty and better-sqlite3.
This machine has no prebuilt binaries and no C++ toolchain:
  $TOOLCHAIN
Full log: $HOME_DIR/install.log
Then re-run this command."
}

if deps_reusable; then
  note "unchanged since the last run - keeping the modules already here"
else
  install_deps
  echo "$WANT_STAMP" >"$STAMP_FILE"
fi

# --- join -------------------------------------------------------------------
step 4/4 "connecting to $HUB_URL"
# --opt=value, not --opt value, and it is not a style choice: an enrollment
# token is base64url, whose alphabet includes '-', so one token in sixty-four
# begins with a dash. Node's parseArgs runs in strict mode and refuses a
# separate argument that looks like another option, which made roughly 1.5% of
# joins die with ERR_PARSE_ARGS_INVALID_OPTION_VALUE after the install had
# already finished. The '=' form has no such ambiguity.
#
# Still nohup with stdout redirected, unlike the PowerShell half, which had to
# stop doing that to keep the hub attached to a console. That fix is for a
# Windows problem and only a Windows problem: a pty here is a pty whether or
# not the process that opened it has a controlling terminal, so detaching
# costs nothing and the daemon behaviour is worth more.
TERMSCAPE_HOME="$HOME_DIR" nohup "$NODE_BIN" "$HOME_DIR/hub/dist/cli.js" \\
  --headless --port 0 --join="$HUB_URL" --join-token="$JOIN_TOKEN" \\
  >"$HOME_DIR/hub.log" 2>&1 &
HUB_PID=$!

# Wait for the join itself, not merely for the hub to start listening. A hub
# that is up but was refused by the canvas is not joined, and saying otherwise
# is how someone ends up staring at a host that never appears.
T0=$(now)
printf '       starting the hub '
i=0
while [ $i -lt 360 ]; do
  if grep -q TERMSCAPE_JOINED= "$HOME_DIR/hub.log" 2>/dev/null; then
    printf ' %s\\n' "$(since "$T0")"
    say ""
    say "Joined. This machine is on the canvas at $HUB_URL"
    note "it keeps running in the background, and rejoins by itself"
    note "log: $HOME_DIR/hub.log"
    say ""
    exit 0
  fi
  if grep -q TERMSCAPE_JOIN_FAILED= "$HOME_DIR/hub.log" 2>/dev/null; then
    printf '\\n'
    REASON=$(grep -m1 TERMSCAPE_JOIN_FAILED= "$HOME_DIR/hub.log" | sed 's/.*TERMSCAPE_JOIN_FAILED=//')
    fail \
"$HUB_URL refused this machine:
  $REASON
Open $HUB_URL/join on this machine for a fresh command - a join key is
single-use and expires after 15 minutes."
  fi
  # Checked last: a refusal, read just above, explains an exit far better
  # than the bare fact of the exit does.
  if ! kill -0 "$HUB_PID" 2>/dev/null; then
    printf '\\n'
    tail -20 "$HOME_DIR/hub.log" >&2 || true
    fail "The hub exited without joining. See $HOME_DIR/hub.log"
  fi
  printf '.'
  i=$((i + 1))
  sleep 0.5
done

printf '\\n'
tail -20 "$HOME_DIR/hub.log" >&2 || true
fail "The hub started but never reported joining $HUB_URL. See $HOME_DIR/hub.log"
`;
}

export function joinScriptPowerShell(origin: string, token: string): string {
  return `# Joins this machine to the Termscape canvas at ${origin}.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # PS5.1's progress bar cripples Invoke-WebRequest

$HubUrl    = ${sq(origin)}
$JoinToken = ${sq(token)}
$HomeDir   = if ($env:TERMSCAPE_HOME) { $env:TERMSCAPE_HOME } else { Join-Path $HOME '.termscape' }
$NodeDist  = ${sq(NODE_DIST)}

# Write-Error, not exit: with $ErrorActionPreference = 'Stop' this ends the
# script, and "exit" inside "irm ... | iex" closes the user's whole console -
# taking the message they need with it.
function Fail($msg) { Write-Host ""; Write-Error $msg }
function Note($msg) { Write-Host "       $msg" }
function Step($n, $title) { Write-Host ""; Write-Host "[$n] $title" }
function Human($bytes) {
  if ($bytes -ge 1MB) { return "{0:N1} MB" -f ($bytes / 1MB) }
  if ($bytes -ge 1KB) { return "{0:N0} KB" -f ($bytes / 1KB) }
  return "$bytes B"
}

function Get-NodeMajor($exe) {
  # Deliberately not "node -p <expression>": PowerShell strips the inner
  # quotes on the way to a native exe, so node would see .split(.)[0].
  try {
    $v = & $exe --version
    if ($v -match '^v(\\d+)\\.') { return [int]$Matches[1] }
    return 0
  } catch { return 0 }
}

# curl.exe ships with Windows 10 1803 and newer - the same vintage as tar,
# which this script already needs - and unlike Invoke-WebRequest it can show a
# progress bar without the PS5.1 slowdown.
$CurlExe = Get-Command curl.exe -ErrorAction SilentlyContinue

function Fetch($url, $dest, $quiet) {
  if ($CurlExe -and -not $quiet) {
    & $CurlExe.Source -f -# -L $url -o $dest
    if ($LASTEXITCODE -ne 0) { Fail "Download failed: $url" }
  } else {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
  }
}

# Long commands run through cmd.exe as a detached process, for two reasons.
#
# The tick: a terminal that prints nothing for a minute looks like one that has
# hung, so we poll and print a dot.
#
# And the redirection has to happen outside PowerShell. In 5.1, sending a
# native command's stderr through a PowerShell stream ("npm ... *> $log") wraps
# every line in an ErrorRecord, so with $ErrorActionPreference = 'Stop' a
# perfectly healthy "npm notice" on stderr kills the script. Start-Process
# redirects at the OS level and never touches PowerShell's error stream.
#
# node running npm's own entrypoint, rather than npm.cmd: CreateProcess cannot
# launch a .cmd without an interpreter once UseShellExecute is off, which is
# what redirecting switches off, and going through cmd.exe would drag in its
# quoting rules for no benefit. $argString is one pre-quoted string because
# -ArgumentList joins an array on spaces without quoting anything.
function Invoke-Ticking($label, $exe, $argString, $log) {
  Write-Host "       $label " -NoNewline
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $exe -ArgumentList $argString \`
        -WorkingDirectory (Get-Location).Path -NoNewWindow -PassThru \`
        -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  # Touching .Handle caches it. Without that, a process from
  # Start-Process -PassThru reports a null ExitCode once it has exited,
  # and a successful install reads as a failure.
  $null = $p.Handle
  while (-not $p.HasExited) {
    Write-Host "." -NoNewline
    Start-Sleep -Seconds 2
  }
  $p.WaitForExit()
  Write-Host " $([int]$sw.Elapsed.TotalSeconds)s"
  if ($null -eq $p.ExitCode) { Fail "Could not read the exit code of $label" }
  return $p.ExitCode
}

# A hub from an earlier join is still running and still holds its own install
# open. On Windows a loaded .node cannot be deleted at all, so without this the
# whole re-join dies on an access-denied removing better-sqlite3. It also stops
# this machine appearing twice on the canvas.
function Stop-RunningHub($hubDir) {
  $pidFile = Join-Path $HomeDir 'hub.pid'
  $targets = @()

  if (Test-Path $pidFile) {
    $recorded = (Get-Content $pidFile -Raw).Trim()
    if ($recorded -match '^\\d+$') {
      $p = Get-Process -Id ([int]$recorded) -ErrorAction SilentlyContinue
      if ($p) { $targets += $p }
    }
  }

  # A hub predating the pid file, or one whose file was lost: find it by the
  # install it was started from.
  if (-not $targets) {
    $targets = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and
        ($_.CommandLine -like "*$hubDir*" -or $_.CommandLine -like "*$HomeDir*")
      } |
      ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
  }

  foreach ($p in $targets) {
    Note "stopping the hub already running here (pid $($p.Id))"
    try {
      $p.CloseMainWindow() | Out-Null
      Stop-Process -Id $p.Id -Force -ErrorAction Stop
      $p.WaitForExit(10000) | Out-Null
    } catch {
      Note "could not stop pid $($p.Id): $($_.Exception.Message)"
    }
  }
  # Windows releases the file handles a moment after the process goes.
  if ($targets) { Start-Sleep -Milliseconds 750 }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
Write-Host ""
Write-Host "Termscape - joining $HubUrl"

# --- node -------------------------------------------------------------------
# A private copy under ~/.termscape, not a system install: no administrator
# rights, no package manager, and no new shell needed to pick up a PATH change.
function Install-Node {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  Note "looking up the latest Node 22 for win-$arch"

  try {
    $sums = (Invoke-WebRequest -Uri "$NodeDist/SHASUMS256.txt" -UseBasicParsing).Content
  } catch {
    Fail "Could not reach $NodeDist - check this machine's internet access.\`n$($_.Exception.Message)"
  }

  $line = $sums -split "\`n" | Where-Object { $_ -match "node-v[\\d.]+-win-$arch\\.zip\\s*$" } | Select-Object -First 1
  if (-not $line) { Fail "nodejs.org has no win-$arch build on the v22 line." }
  $fields  = ($line.Trim() -split '\\s+')
  $wantSha = $fields[0]
  $zipName = $fields[1]

  $zip = Join-Path $HomeDir $zipName
  Note "downloading $zipName (about 30 MB)"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Fetch "$NodeDist/$zipName" $zip $false
  Note "downloaded $(Human (Get-Item $zip).Length) in $([int]$sw.Elapsed.TotalSeconds)s"

  # We are about to execute this, so verify it rather than trusting the pipe.
  Write-Host "       verifying checksum ... " -NoNewline
  $gotSha = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
  if ($gotSha -ne $wantSha.ToLower()) {
    Write-Host "FAILED"
    Remove-Item $zip -Force
    Fail "Checksum mismatch on $zipName. Refusing to run it."
  }
  Write-Host "ok"

  Note "unpacking into $HomeDir\\node"
  $staging = Join-Path $HomeDir 'node-unzip'
  if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
  Expand-Archive -Path $zip -DestinationPath $staging -Force
  Remove-Item $zip -Force

  # The zip wraps everything in node-vX.Y.Z-win-arch\\; lift that up a level so
  # the path is stable across versions.
  $inner = Get-ChildItem -Path $staging -Directory | Select-Object -First 1
  $target = Join-Path $HomeDir 'node'
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Move-Item -Path $inner.FullName -Destination $target
  Remove-Item -Recurse -Force $staging

  Note "installed $(& (Join-Path $target 'node.exe') --version)"
}

Step '1/4' 'Node 22'
$privateNode = Join-Path $HomeDir 'node\\node.exe'

if ((Test-Path $privateNode) -and (Get-NodeMajor $privateNode) -ge 22) {
  Note "$(& $privateNode --version) already here (private copy)"
} elseif ((Get-Command node -ErrorAction SilentlyContinue) -and (Get-NodeMajor 'node') -ge 22) {
  Note "$(node --version) already on this machine"
} else {
  if (Get-Command node -ErrorAction SilentlyContinue) {
    Note "$(node --version) is older than 22; fetching a private copy"
  } else {
    Note "not installed; fetching a private copy"
  }
  Install-Node
}

if (Test-Path $privateNode) {
  $NodeExe  = $privateNode
  $NodeHome = Join-Path $HomeDir 'node'
  # Anything npm shells out to must find the private copy first.
  $env:PATH = $NodeHome + ';' + $env:PATH
} else {
  $NodeExe  = (Get-Command node).Source
  $NodeHome = Split-Path $NodeExe -Parent
}
$NpmCli = Join-Path $NodeHome 'node_modules\\npm\\bin\\npm-cli.js'
if (-not (Test-Path $NpmCli)) { Fail "Could not find npm alongside $NodeExe" }

# --- the hub ----------------------------------------------------------------
Step '2/4' 'hub package'
Note "downloading from $HubUrl"
$tgz = Join-Path $HomeDir 'hub.tgz'
Fetch "$HubUrl/hub.tgz" $tgz $true
Note "got $(Human (Get-Item $tgz).Length)"

$hubDir = Join-Path $HomeDir 'hub'
$hubModules = Join-Path $hubDir 'node_modules'
Stop-RunningHub $hubDir

# The dependency tree is the slowest thing here to rebuild and the tarball
# never carries one, so it is moved aside rather than deleted along with the
# rest of the install. Whether it can be kept is step 3's question. It also
# means far less for the removal below to fail on: a loaded .node is the file
# Windows refuses to delete.
$keptModules = Join-Path $HomeDir 'node_modules.kept'
if (Test-Path $keptModules) { Remove-Item -Recurse -Force $keptModules }
if (Test-Path $hubModules) { Move-Item $hubModules $keptModules }

if (Test-Path $hubDir) {
  try {
    Remove-Item -Recurse -Force $hubDir
  } catch {
    Fail ("Could not replace the previous install at $hubDir - something still has a file open there." + [Environment]::NewLine +
          "A hub from an earlier join is probably still running. Close it and re-run this command." + [Environment]::NewLine +
          $_.Exception.Message)
  }
}
New-Item -ItemType Directory -Force -Path $hubDir | Out-Null
# tar ships with Windows 10 1803 and newer.
tar xzf $tgz -C $hubDir --strip-components=1
if (Test-Path $keptModules) { Move-Item $keptModules $hubModules }
Note "unpacked into $hubDir"

# --- install ----------------------------------------------------------------
Step '3/4' 'dependencies'
$log = Join-Path $HomeDir 'install.log'
Note "full log: $log"
Push-Location $hubDir

# What the tree already here would have to match to be worth keeping: the
# fingerprint the tarball shipped, plus the two things it cannot know - the
# Node ABI these modules were built against, and the platform.
$stampFile = Join-Path $HomeDir 'deps.stamp'
$fingerprintFile = Join-Path $hubDir 'deps.fingerprint'
$fingerprint = 'none'
if (Test-Path $fingerprintFile) {
  $fingerprint = ((Get-Content $fingerprintFile -TotalCount 1) + '').Trim()
}
# Single quotes inside a double-quoted string, deliberately: PowerShell
# strips a double quote out of an argument on its way to a native command,
# and this expression would reach node as unparseable JavaScript.
$abiJs = "process.versions.node.split('.')[0] + '-' + process.platform + '-' + process.arch"
$nodeAbi = & $NodeExe -p $abiJs
$wantStamp = "$fingerprint-$nodeAbi"
$haveStamp = ''
if (Test-Path $stampFile) { $haveStamp = ((Get-Content $stampFile -TotalCount 1) + '').Trim() }

$reusable = $false
if ((Test-Path $hubModules) -and ($haveStamp -eq $wantStamp)) {
  # The stamp claims this tree still works. Confirming it does costs one Node
  # start, and is the whole difference between an optimisation and a machine
  # that joins with a hub unable to load its own modules. The probe catches
  # its own errors and reports through stdout and an exit code, so nothing
  # reaches PowerShell's error stream - where 5.1 turns a native command's
  # stderr into a terminating error.
  #
  # It imports the hub's own entry rather than requiring the two native
  # modules: that links the whole graph, so it still catches a module built
  # for the wrong ABI and additionally catches a stale @termscape/protocol,
  # which fails at link time with "does not provide an export named X". See
  # the POSIX half for why that can happen at all.
  $probe = "import('./dist/hub.js').catch(e => { console.log('dependency probe failed: ' + e.message); process.exit(1) })"
  & $NodeExe -e $probe > $log
  $reusable = ($LASTEXITCODE -eq 0)
}

if ($reusable) {
  Note "unchanged since the last run - keeping the modules already here"
} else {
  Note "this is the slow part - a minute or two on a first run"
  # A half-finished tree must not inherit the last run's stamp.
  if (Test-Path $stampFile) { Remove-Item $stampFile -Force }

  # The vendored workspace package has to go before npm runs - see the POSIX
  # half for why npm will otherwise keep last build's copy of it.
  $vendored = Join-Path $hubModules '@termscape'
  if (Test-Path $vendored) { Remove-Item $vendored -Recurse -Force }

  # Prebuilt binaries first; compiling is the fallback, not the default.
  $npmArgs = '"' + $NpmCli + '" install --omit=dev --no-audit --no-fund'
  $rc = Invoke-Ticking 'installing' $NodeExe $npmArgs $log
  if ($rc -ne 0) {
    Note "no prebuilt binaries for this platform; compiling instead"
    $rc = Invoke-Ticking 'compiling' $NodeExe ($npmArgs + ' --build-from-source') $log
    if ($rc -ne 0) {
      Get-Content $log -Tail 20 | Write-Host
      Pop-Location
      Fail "Could not install node-pty and better-sqlite3.\`nThis machine has no prebuilt binaries and no C++ toolchain. Install the Visual Studio Build Tools with the 'Desktop development with C++' workload:\`n  https://visualstudio.microsoft.com/visual-cpp-build-tools/\`nFull log: $log\`nThen re-run this command."
    }
  }

  Set-Content -Path $stampFile -Value $wantStamp -Encoding ascii
}
Pop-Location

# --- join -------------------------------------------------------------------
Step '4/4' "connecting to $HubUrl"
$hubLog = Join-Path $HomeDir 'hub.log'
# Cleared here rather than appended to: the wait below greps the whole file,
# and a previous run's TERMSCAPE_JOINED= would satisfy it before this hub had
# said anything at all.
Remove-Item $hubLog -ErrorAction SilentlyContinue
$env:TERMSCAPE_HOME = $HomeDir
# Three things here are deliberate and none of them is obvious.
#
# cli.js is named absolutely so this hub is findable in the process list by
# the install it came from - which is how a later re-join knows what to stop.
#
# --opt=value rather than two arguments: a base64url token may begin with a
# dash, and Node's strict parseArgs refuses a separate value that looks like
# an option. See the POSIX half for what that cost.
#
# -WindowStyle Hidden with no stdio redirection: detached, so closing the
# window that ran the installer does not take the hub with it, and its output
# goes through --log-file rather than a pipe.
#
# It briefly ran attached to the installer's console instead, on the theory
# that a process with no console of its own creates pseudoconsoles that
# swallow an agent's mouse-mode request. Measured on Windows 10, it does not:
# the agent behaves identically either way. What the experiment did cost was
# the daemon property - the hub died the moment the window closed - so the
# console is not worth keeping and the log file is.
$cliArgs = '"' + (Join-Path $hubDir 'dist/cli.js') + '"' +
           ' --headless --port 0 --join="' + $HubUrl + '" --join-token="' + $JoinToken + '"' +
           ' --log-file="' + $hubLog + '"'
$hubProc = Start-Process -FilePath $NodeExe -ArgumentList $cliArgs -PassThru \`
  -WorkingDirectory $hubDir -WindowStyle Hidden
# Same trap as the install: without touching .Handle, HasExited on a process
# from Start-Process -PassThru is not reliable.
$null = $hubProc.Handle

# Wait for the join itself, not merely for the hub to start listening. A hub
# that is up but was refused by the canvas is not joined, and saying otherwise
# is how someone ends up staring at a host that never appears.
Write-Host "       starting the hub " -NoNewline
$sw = [Diagnostics.Stopwatch]::StartNew()
for ($i = 0; $i -lt 360; $i++) {
  $joined = $false
  $refused = $null
  # The hub is writing this file as we read it, so a locked read is a retry,
  # not a failure.
  try {
    if (Test-Path $hubLog) {
      $joined  = Select-String -Path $hubLog -Pattern 'TERMSCAPE_JOINED=' -Quiet
      $refused = Select-String -Path $hubLog -Pattern 'TERMSCAPE_JOIN_FAILED=(.*)' |
                   Select-Object -First 1
    }
  } catch { $joined = $false }

  if ($joined) {
    Write-Host " $([int]$sw.Elapsed.TotalSeconds)s"
    Write-Host ""
    Write-Host "Joined. This machine is on the canvas at $HubUrl"
    Note "it keeps running in the background, and rejoins by itself"
    Note "log: $hubLog"
    Write-Host ""
    return
  }

  if ($refused) {
    $reason = $refused.Matches[0].Groups[1].Value.Trim()
    Write-Host ""
    Fail ("$HubUrl refused this machine:" + [Environment]::NewLine +
          "  $reason" + [Environment]::NewLine +
          "Open $HubUrl/join on this machine for a fresh command - a join key is" +
          [Environment]::NewLine + "single-use and expires after 15 minutes.")
  }

  # Checked last: a refusal, read just above, explains an exit far better
  # than the bare fact of the exit does.
  if ($hubProc.HasExited) {
    Write-Host ""
    if (Test-Path $hubLog) { Get-Content $hubLog -Tail 20 | Write-Host }
    Fail "The hub exited without joining. See $hubLog"
  }

  Write-Host "." -NoNewline
  Start-Sleep -Milliseconds 500
}

Write-Host ""
if (Test-Path $hubLog) { Get-Content $hubLog -Tail 20 | Write-Host }
Fail "The hub started but never reported joining $HubUrl. See $hubLog"
`;
}
