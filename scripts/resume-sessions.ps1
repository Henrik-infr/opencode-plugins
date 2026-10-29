# Lists the interactive opencode sessions that died or were interrupted, and reopens them on request.
# The opencode plugin writes <registry>\<session id>.json for every interactive session.
# A session counts as running while its heartbeat is fresh (lastActive within 10 minutes);
# one that exited on purpose (/exit, ctrl+c, /clear) is skipped.
#
#   pwsh -File resume-sessions.ps1                         # list them, newest first
#   pwsh -File resume-sessions.ps1 -Launch                 # reopen each in a WezTerm tab
#   pwsh -File resume-sessions.ps1 -Launch -Terminal windows-terminal
param(
    [switch]$Launch,
    [int]$MaxAgeHours = 72,
    [int]$PruneDays = 14,
    [string]$Registry,
    [ValidateSet('wezterm', 'windows-terminal')]
    [string]$Terminal = 'wezterm'
)

$ErrorActionPreference = 'Stop'
$now = [DateTime]::UtcNow

# Same default as the plugin: the opencode darling-data folder.
if (-not $Registry) { $Registry = Join-Path $env:USERPROFILE '.config\opencode\darling-data\sessions-registry' }

$found = @()
if (Test-Path -LiteralPath $Registry) {
    foreach ($f in Get-ChildItem -LiteralPath $Registry -Filter '*.json' -File) {
        if ($f.LastWriteTimeUtc -lt $now.AddDays(-$PruneDays)) { Remove-Item -LiteralPath $f.FullName -Confirm:$false; continue }
        try { $e = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json } catch { continue }
        if (-not $e.sessionId -or $e.ended -eq 'exited') { continue }
        # ConvertFrom-Json already turns an ISO string into a DateTime; a string is parsed as UTC.
        $last = if ($e.lastActive -is [DateTime]) { $e.lastActive } else {
            [DateTime]::Parse([string]$e.lastActive, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
        }
        $last = if ($last.Kind -eq [DateTimeKind]::Unspecified) { [DateTime]::SpecifyKind($last, [DateTimeKind]::Utc) } else { $last.ToUniversalTime() }
        if ($last -gt $now.AddMinutes(-10)) { continue } # fresh heartbeat: the session is still running
        if ($last -lt $now.AddHours(-$MaxAgeHours)) { continue }
        $found += [pscustomobject]@{ Entry = $e; Last = $last }
    }
}

if ($found.Count -eq 0) {
    'No interrupted sessions in the last {0} hours.' -f $MaxAgeHours
    return
}

$found = @($found | Sort-Object Last -Descending)
$opencode = (Get-Command opencode -ErrorAction SilentlyContinue).Source
if (-not $opencode) { $opencode = 'opencode' }

function Get-ResumeArgs($e) {
    # The tab must start in the entry's directory: opencode picks the session up from there.
    return @('--session', [string]$e.sessionId)
}

'{0} interrupted session(s), newest first:' -f $found.Count
foreach ($one in $found) {
    $e = $one.Entry
    $state = if ($e.ended -eq 'interrupted') { 'interrupted' } else { 'died' }
    $label = if ($e.title) { $e.title } else { '(no name)' }
    '{0:yyyy-MM-dd HH:mm}Z  {1,-11}  {2}  {3}' -f $one.Last, $state, $label, $e.directory
    '    cd "{0}"; opencode {1}' -f $e.directory, ((Get-ResumeArgs $e) -join ' ')
}

if (-not $Launch) {
    $name = if ($Terminal -eq 'wezterm') { 'WezTerm' } else { 'Windows Terminal' }
    'Reopen them all in {0} tabs: pwsh -File "{1}" -Launch -Terminal {2}' -f $name, $PSCommandPath, $Terminal
    return
}

if ($Terminal -eq 'wezterm') {
    $wez = (Get-Command wezterm -ErrorAction SilentlyContinue).Source
    if (-not $wez) { throw 'wezterm is not on PATH; reopen each session with its line above.' }
} else {
    $wt = (Get-Command wt -ErrorAction SilentlyContinue).Source
    if (-not $wt) { throw 'wt (Windows Terminal) is not on PATH; reopen each session with its line above.' }
}
foreach ($one in $found) {
    $e = $one.Entry
    $cmd = @($opencode) + (Get-ResumeArgs $e)
    if ($Terminal -eq 'wezterm') {
        if ($env:WEZTERM_PANE) {
            & $wez cli spawn --cwd $e.directory -- @cmd | Out-Null
        } else {
            Start-Process -FilePath $wez -ArgumentList (@('start', '--cwd', $e.directory, '--') + $cmd)
        }
    } else {
        # -w 0 opens a tab in the newest Windows Terminal window; Start-Process quotes each argument for us.
        Start-Process -FilePath $wt -ArgumentList (@('-w', '0', 'new-tab', '-d', $e.directory, '--') + $cmd)
    }
    'Reopened {0} in {1}' -f $(if ($e.title) { $e.title } else { $e.sessionId }), $e.directory
}
