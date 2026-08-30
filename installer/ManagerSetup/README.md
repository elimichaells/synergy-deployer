# Manager Setup executable

`ManagerSetup.exe` is the graphical Windows Server installer. It is a
self-contained .NET 8 WPF application, so the target server does not need the
.NET runtime or SDK.

The wizard supports two package sources:

- Online: downloads `manager-windows-*.zip` and its matching
  `.sha256.json` asset from a versioned GitHub Release.
- Offline: extracts the same checksummed package embedded in the executable.

GitHub tokens and installation passwords remain in memory and are passed to the
PowerShell provisioning engine through child-process environment variables.
They are not placed in command arguments or the temporary JSON configuration.

Build both release artifacts from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-manager-exe.ps1
```

The build emits the setup EXE, Manager ZIP, and SHA-256 manifests in `packages`.
If .NET 8 is not installed, the build script downloads a private SDK under the
current user's local application-data directory; it does not install a system
runtime or service. The generated executable validates its embedded payload as
part of every build.

Before external distribution, sign `ManagerSetup.exe` with the organization's
Authenticode certificate and upload all four generated files to the same GitHub
Release. Tag pushes run `.github/workflows/manager-release.yml` to build and
publish these assets automatically.

To sign during packaging, import the code-signing certificate into the current
user or local-machine certificate store and pass its thumbprint:

```powershell
.\scripts\package-manager-exe.ps1 `
  -CodeSigningCertificateThumbprint "CERTIFICATE_THUMBPRINT"
```
