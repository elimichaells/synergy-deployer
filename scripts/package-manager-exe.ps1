[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [string]$Version,
    [string]$DotNetPath,
    [string]$CodeSigningCertificateThumbprint,
    [string]$TimestampServer = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root 'packages' }
if (-not $Version) { $Version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$projectDirectory = Join-Path $root 'installer\ManagerSetup'
$assetsDirectory = Join-Path $projectDirectory 'Assets'
$buildRoot = Join-Path $env:TEMP ('manager-setup-build-' + [guid]::NewGuid().ToString('N'))
$payloadDirectory = Join-Path $buildRoot 'payload'
$publishDirectory = Join-Path $buildRoot 'publish'
$smokeReport = Join-Path $buildRoot 'smoke-test.txt'
$generatedPackageAsset = Join-Path $assetsDirectory 'manager-package.zip'
$generatedManifestAsset = Join-Path $assetsDirectory 'manager-package.sha256.json'

$resolvedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
$resolvedBuildRoot = [IO.Path]::GetFullPath($buildRoot)
if (-not $resolvedBuildRoot.StartsWith($resolvedTemp,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Executable build staging escaped the Windows temporary directory'
}

function Resolve-DotNet {
    if ($DotNetPath) {
        $candidate = [IO.Path]::GetFullPath($DotNetPath)
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw ('dotnet was not found: ' + $candidate) }
        return $candidate
    }
    $command = Get-Command dotnet.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $toolRoot = Join-Path $env:LOCALAPPDATA 'ManagerSetupBuild\dotnet'
    $candidate = Join-Path $toolRoot 'dotnet.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }

    Write-Host 'A system .NET SDK was not found. Downloading a private .NET 8 build SDK...' -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null
    $installer = Join-Path $buildRoot 'dotnet-install.ps1'
    Invoke-WebRequest 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installer -UseBasicParsing
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer -Channel 8.0 -Quality GA -InstallDir $toolRoot -NoPath | Out-Host
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw 'The private .NET 8 SDK installation failed'
    }
    return $candidate
}

New-Item -ItemType Directory -Force -Path $payloadDirectory,$publishDirectory,$assetsDirectory | Out-Null
try {
    Write-Host 'Building the versioned Manager application package...' -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot 'package-manager.ps1') -OutputDirectory $payloadDirectory -Version $Version
    if ($LASTEXITCODE -ne 0) { throw 'Manager application packaging failed' }
    $package = Get-ChildItem -LiteralPath $payloadDirectory -Filter '*.zip' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $package) { throw 'The Manager application package was not created' }
    $packageManifest = Get-Item -LiteralPath ($package.FullName + '.sha256.json') -ErrorAction Stop
    $packageMetadata = Get-Content -LiteralPath $packageManifest.FullName -Raw | ConvertFrom-Json
    Copy-Item -LiteralPath $package.FullName -Destination $generatedPackageAsset -Force
    Copy-Item -LiteralPath $packageManifest.FullName -Destination $generatedManifestAsset -Force

    $dotnet = Resolve-DotNet
    $env:DOTNET_ROOT = Split-Path -Parent $dotnet
    $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
    $env:DOTNET_NOLOGO = '1'
    Write-Host ('Publishing ManagerSetup.exe with ' + (& $dotnet --version)) -ForegroundColor Cyan
    & $dotnet publish (Join-Path $projectDirectory 'ManagerSetup.csproj') --configuration Release --runtime win-x64 --self-contained true --output $publishDirectory ('/p:Version=' + $Version)
    if ($LASTEXITCODE -ne 0) { throw 'Manager Setup publishing failed' }

    $publishedExe = Join-Path $publishDirectory 'ManagerSetup.exe'
    if (-not (Test-Path -LiteralPath $publishedExe -PathType Leaf)) { throw 'ManagerSetup.exe was not published' }
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $exeName = 'manager-setup-' + $Version + '-' + $timestamp + '.exe'
    $finalExe = Join-Path $OutputDirectory $exeName
    Copy-Item -LiteralPath $publishedExe -Destination $finalExe -Force
    Copy-Item -LiteralPath $package.FullName -Destination (Join-Path $OutputDirectory $package.Name) -Force
    Copy-Item -LiteralPath $packageManifest.FullName -Destination (Join-Path $OutputDirectory $packageManifest.Name) -Force

    if ($CodeSigningCertificateThumbprint) {
        $thumbprint = $CodeSigningCertificateThumbprint.Replace(' ','').ToUpperInvariant()
        $certificate = Get-ChildItem Cert:\CurrentUser\My,Cert:\LocalMachine\My -CodeSigningCert -ErrorAction SilentlyContinue |
            Where-Object { $_.Thumbprint -eq $thumbprint } | Select-Object -First 1
        if (-not $certificate) { throw ('Code-signing certificate was not found: ' + $thumbprint) }
        $signed = Set-AuthenticodeSignature -LiteralPath $finalExe -Certificate $certificate -TimestampServer $TimestampServer -HashAlgorithm SHA256
        if ($signed.Status -ne 'Valid') { throw ('Authenticode signing failed: ' + $signed.StatusMessage) }
    }

    Write-Host 'Running the executable embedded-payload smoke test...' -ForegroundColor Cyan
    $smoke = Start-Process -FilePath $finalExe -ArgumentList @('--smoke-test','--smoke-report',$smokeReport) -Wait -PassThru -WindowStyle Hidden
    if ($smoke.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $smokeReport -PathType Leaf)) {
        throw ('ManagerSetup.exe smoke test failed with exit code ' + $smoke.ExitCode)
    }
    $smokeResult = Get-Content -LiteralPath $smokeReport -Raw
    if (-not $smokeResult.StartsWith('PASS:')) { throw ('ManagerSetup.exe smoke test failed: ' + $smokeResult) }

    $hash = (Get-FileHash -LiteralPath $finalExe -Algorithm SHA256).Hash
    $signature = Get-AuthenticodeSignature -LiteralPath $finalExe
    $manifestPath = $finalExe + '.sha256.json'
    [ordered]@{
        file=$exeName
        sha256=$hash
        version=$Version
        sourceCommit=$packageMetadata.sourceCommit
        sourceDirty=$packageMetadata.sourceDirty
        architecture='win-x64'
        package=$package.Name
        packageSha256=(Get-FileHash -LiteralPath $package.FullName -Algorithm SHA256).Hash
        signatureStatus=[string]$signature.Status
        createdAt=(Get-Date).ToUniversalTime().ToString('o')
        smokeTest=$smokeResult.Trim()
    } | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding UTF8

    Write-Host ('Setup executable: ' + $finalExe) -ForegroundColor Green
    Write-Host ('SHA256: ' + $hash) -ForegroundColor Green
    Write-Host ('Smoke test: ' + $smokeResult.Trim()) -ForegroundColor Green
    if ($signature.Status -ne 'Valid') {
        Write-Warning 'ManagerSetup.exe is not code-signed. Sign the final executable before public distribution.'
    }
} finally {
    Remove-Item -LiteralPath $generatedPackageAsset,$generatedManifestAsset -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $resolvedBuildRoot) {
        Remove-Item -LiteralPath $resolvedBuildRoot -Recurse -Force
    }
}
