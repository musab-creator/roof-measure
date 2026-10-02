param([int]$Port = 8080, [switch]$Open)
# Minimal local server for Roof Measure at http://localhost:8080/
# - serves the app files
# - POST /save?name=<file>  writes the request body into the "reports" folder (used by "Save to Reports folder")
# Only needed if you restrict your API key by website or want reports saved straight to disk; otherwise double-click index.html.
$root = (Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$reports = Join-Path $root "reports"
if (-not (Test-Path $reports)) { New-Item -ItemType Directory -Path $reports | Out-Null }
# large height-model cache files (_ccache_*) stay on this PC, outside OneDrive
$cache = Join-Path $env:LOCALAPPDATA "RoofMeasureCache"
if (-not (Test-Path $cache)) { New-Item -ItemType Directory -Path $cache | Out-Null }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Roof Measure running at http://localhost:$Port/   (close this window to stop)"
if ($Open) { Start-Process "http://localhost:$Port/" }
$mime = @{ ".html"="text/html; charset=utf-8"; ".js"="application/javascript; charset=utf-8"; ".css"="text/css; charset=utf-8"; ".json"="application/json"; ".png"="image/png"; ".jpg"="image/jpeg"; ".svg"="image/svg+xml"; ".ico"="image/x-icon"; ".md"="text/plain; charset=utf-8"; ".pdf"="application/pdf" }
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request; $res = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
    if ($req.HttpMethod -eq "POST" -and $path -eq "/save") {
      $name = $req.QueryString["name"]; if (-not $name) { $name = "report.html" }
      $name = ($name -replace '[\\/:*?"<>|]', '_')
      $ms = New-Object IO.MemoryStream; $req.InputStream.CopyTo($ms)
      $target = if ($name.StartsWith("_ccache_")) { Join-Path $cache $name } else { Join-Path $reports $name }
      [IO.File]::WriteAllBytes($target, $ms.ToArray())
      $body = [Text.Encoding]::UTF8.GetBytes('{"saved":"' + ($target -replace '\\', '\\\\') + '"}')
      $res.ContentType = "application/json"; $res.ContentLength64 = $body.Length; $res.OutputStream.Write($body, 0, $body.Length)
    } else {
      if ($path -eq "/") { $path = "/index.html" }
      $file = Join-Path $root ($path.TrimStart("/") -replace "/", "\")
      $full = [IO.Path]::GetFullPath($file)
      $okRoot = $root
      if ($path.StartsWith("/reports/_ccache_")) { $full = [IO.Path]::GetFullPath((Join-Path $cache ($path.Substring(9) -replace '[\\/:*?"<>|]', '_'))); $okRoot = $cache }
      if ($full.StartsWith($okRoot) -and (Test-Path $full -PathType Leaf)) {
        $bytes = [IO.File]::ReadAllBytes($full)
        $ext = [IO.Path]::GetExtension($full).ToLower()
        if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] } else { $res.ContentType = "application/octet-stream" }
        $res.Headers.Add("Cache-Control", "no-store")
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      } else { $res.StatusCode = 404 }
    }
  } catch { $res.StatusCode = 500 } finally { $res.OutputStream.Close() }
}
