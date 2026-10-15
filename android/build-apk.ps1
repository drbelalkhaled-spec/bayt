param(
    [string]$AndroidSdkPath = $env:ANDROID_HOME,
    [string]$JdkPath = $env:JAVA_HOME,
    [string]$BuildToolsVersion = '36.0.0'
)

$ErrorActionPreference = 'Stop'
if (!$AndroidSdkPath -or !$JdkPath) {
    throw 'Set ANDROID_HOME and JAVA_HOME, or pass -AndroidSdkPath and -JdkPath.'
}

$env:JAVA_HOME = $JdkPath
$env:ANDROID_HOME = $AndroidSdkPath
$env:ANDROID_SDK_ROOT = $AndroidSdkPath
$sdkTools = Join-Path $AndroidSdkPath "build-tools/$BuildToolsVersion"
$keyPath = Join-Path $PSScriptRoot 'signing/bayt-release.keystore'
$passwordPath = Join-Path $PSScriptRoot 'signing/password.txt'
if (!(Test-Path -LiteralPath $keyPath) -or !(Test-Path -LiteralPath $passwordPath)) {
    throw 'Restore the original private signing folder before building an update. See android/README.md.'
}

$releaseDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../releases'))
New-Item -ItemType Directory -Force -Path $releaseDirectory | Out-Null
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'twa-manifest.json') -Raw | ConvertFrom-Json
$apkPath = Join-Path $releaseDirectory "Bayt-$($manifest.appVersion).apk"
$alignedPath = Join-Path $releaseDirectory 'bayt-aligned-unsigned.apk'

Push-Location $PSScriptRoot
try {
    & ./gradlew.bat --no-daemon --console=plain assembleRelease lintRelease
    if ($LASTEXITCODE -ne 0) { throw 'Android build or lint failed.' }
    & (Join-Path $sdkTools 'zipalign.exe') -f -p 4 app/build/outputs/apk/release/app-release-unsigned.apk $alignedPath
    if ($LASTEXITCODE -ne 0) { throw 'APK alignment failed.' }
    # PKCS12 uses the same password for the store and key. apksigner reuses it;
    # supplying the same password file twice would consume its only line twice.
    & (Join-Path $sdkTools 'apksigner.bat') sign --ks $keyPath --ks-key-alias bayt --ks-pass "file:$passwordPath" --out $apkPath $alignedPath
    if ($LASTEXITCODE -ne 0) { throw 'APK signing failed.' }
    & (Join-Path $sdkTools 'apksigner.bat') verify --verbose --print-certs $apkPath
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    Get-FileHash -LiteralPath $apkPath -Algorithm SHA256 |
        ForEach-Object { "$($_.Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($apkPath))" } |
        Set-Content -LiteralPath "$apkPath.sha256" -Encoding ascii
    Write-Output "Signed APK: $apkPath"
} finally {
    Pop-Location
}
