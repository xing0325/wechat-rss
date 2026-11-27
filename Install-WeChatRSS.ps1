[CmdletBinding()]
param(
    [string]$ProjectPath = (Join-Path $env:USERPROFILE 'wechat-rss')
)

$ErrorActionPreference = 'Stop'
$project = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ProjectPath)
$plugin = 'wechat-rss@wechat-rss-local'
$node = (Get-Command node -CommandType Application).Source
$codex = Get-Command codex

& $node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1); require("node:sqlite");'
if ($LASTEXITCODE -ne 0) { throw 'Node.js 24 or newer with node:sqlite is required.' }

& $codex plugin marketplace add $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw 'Could not register the local Codex marketplace.' }
& $codex plugin add $plugin
if ($LASTEXITCODE -ne 0) { throw 'Could not install the Codex plugin.' }

$bootstrap = Join-Path $PSScriptRoot 'plugins/wechat-rss/skills/wechat-rss/scripts/bootstrap.mjs'
& $node $bootstrap $project
if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the local project.' }
Write-Output "Open a new local Codex chat in: $project"
