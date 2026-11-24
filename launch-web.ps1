$ErrorActionPreference = 'Stop'
$gameUrl = 'http://127.0.0.1:8788/'
$node = (Get-Command node).Source
foreach ($file in 'index.html','avp.js','assets.js','avp.wasm','avp.data') {
    if (!(Test-Path (Join-Path $PSScriptRoot "build-web/$file") -PathType Leaf)) {
        throw "Missing build-web/$file. Build the web game first (see WEB_MULTIPLAYER.md)."
    }
}
function Test-Ready($url, $expected) {
    try { return (Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 2).Content.Contains($expected) }
    catch { return $false }
}
function Start-AvpService($script, $url, $expected) {
    if (Test-Ready $url $expected) { return }
    $service = Start-Process $node -WorkingDirectory $PSScriptRoot -ArgumentList "web-multiplayer/$script" -WindowStyle Hidden -PassThru
    for ($i = 0; $i -lt 25; $i++) {
        if (Test-Ready $url $expected) { return }
        if ($service.HasExited) { break }
        Start-Sleep -Milliseconds 200
    }
    throw "Could not start $script at $url"
}
Start-AvpService 'relay.js' 'http://127.0.0.1:8080/health' 'avp relay ready'
Start-AvpService 'serve.js' $gameUrl '<title>Aliens versus Predator Classic</title>'
Start-Process $gameUrl
