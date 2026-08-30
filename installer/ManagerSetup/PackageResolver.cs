using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ManagerSetup;

internal static class PackageResolver
{
    private const string PackageResource = "ManagerSetup.Assets.manager-package.zip";
    private const string ManifestResource = "ManagerSetup.Assets.manager-package.sha256.json";
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    public static async Task<PackagePayload> ResolveAsync(
        InstallOptions options,
        Action<string> progress,
        CancellationToken cancellationToken)
    {
        var cacheRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "Manager", "InstallerCache");
        Directory.CreateDirectory(cacheRoot);

        string zipPath;
        PackageManifest manifest;
        string source;

        if (options.UseOnlinePackage)
        {
            progress("Resolving the requested GitHub release...");
            (zipPath, manifest) = await DownloadReleaseAsync(options, cacheRoot, progress, cancellationToken);
            source = $"GitHub release {options.GitHubRepository}@{manifest.Version}";
        }
        else
        {
            progress("Reading the embedded offline package...");
            (zipPath, manifest) = await CopyEmbeddedPackageAsync(cacheRoot, cancellationToken);
            source = "Embedded offline package";
        }

        progress("Verifying package SHA-256...");
        var actualHash = await ComputeSha256Async(zipPath, cancellationToken);
        if (!actualHash.Equals(manifest.Sha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException($"Package integrity check failed. Expected {manifest.Sha256}, received {actualHash}.");
        }

        var safeVersion = SanitizePathSegment(manifest.Version);
        var payloadRoot = Path.Combine(cacheRoot, $"payload-{safeVersion}-{actualHash[..12].ToLowerInvariant()}");
        var markerPath = Path.Combine(payloadRoot, ".manager-package-verified");
        if (Directory.Exists(payloadRoot) && !File.Exists(markerPath))
        {
            payloadRoot += "-" + Guid.NewGuid().ToString("N");
            markerPath = Path.Combine(payloadRoot, ".manager-package-verified");
        }
        if (!File.Exists(markerPath))
        {
            var extractionRoot = payloadRoot + ".extracting-" + Guid.NewGuid().ToString("N");
            progress("Extracting the verified Manager package...");
            Directory.CreateDirectory(extractionRoot);
            try
            {
                await ExtractSafelyAsync(zipPath, extractionRoot, cancellationToken);
                ValidatePayload(extractionRoot);
                await File.WriteAllTextAsync(Path.Combine(extractionRoot, ".manager-package-verified"), actualHash, cancellationToken);
                if (Directory.Exists(payloadRoot)) throw new IOException("The verified package destination already exists.");
                Directory.Move(extractionRoot, payloadRoot);
            }
            catch
            {
                if (Directory.Exists(extractionRoot))
                {
                    Directory.Delete(extractionRoot, true);
                }
                throw;
            }
        }

        ValidatePayload(payloadRoot);
        progress($"Manager {manifest.Version} package is verified and ready.");
        return new PackagePayload(payloadRoot, manifest.Version, actualHash, source);
    }

    public static async Task<PackageValidation> ValidateEmbeddedPackageAsync()
    {
        var assembly = Assembly.GetExecutingAssembly();
        await using var packageStream = assembly.GetManifestResourceStream(PackageResource)
            ?? throw new InvalidDataException("The embedded Manager package is missing.");
        await using var manifestStream = assembly.GetManifestResourceStream(ManifestResource)
            ?? throw new InvalidDataException("The embedded package manifest is missing.");

        var manifest = await JsonSerializer.DeserializeAsync<PackageManifest>(manifestStream, JsonOptions)
            ?? throw new InvalidDataException("The embedded package manifest is invalid.");
        ValidateManifest(manifest);
        var actualHash = Convert.ToHexString(await SHA256.HashDataAsync(packageStream));
        if (!actualHash.Equals(manifest.Sha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("The embedded Manager package failed its SHA-256 check.");
        }

        packageStream.Position = 0;
        using var archive = new ZipArchive(packageStream, ZipArchiveMode.Read, leaveOpen: true);
        var names = archive.Entries.Select(entry => entry.FullName.Replace('\\', '/')).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var required in RequiredEntries)
        {
            if (!names.Contains(required))
            {
                throw new InvalidDataException($"The embedded package is missing {required}.");
            }
        }
        return new PackageValidation(manifest.Version, actualHash);
    }

    private static readonly string[] RequiredEntries =
    [
        "scripts/install-manager.ps1",
        "setup.ps1",
        "setup.cmd",
        "package.json"
    ];

    private static async Task<(string ZipPath, PackageManifest Manifest)> CopyEmbeddedPackageAsync(
        string cacheRoot,
        CancellationToken cancellationToken)
    {
        var assembly = Assembly.GetExecutingAssembly();
        await using var manifestStream = assembly.GetManifestResourceStream(ManifestResource)
            ?? throw new InvalidDataException("The embedded package manifest is missing.");
        var manifest = await JsonSerializer.DeserializeAsync<PackageManifest>(manifestStream, JsonOptions, cancellationToken)
            ?? throw new InvalidDataException("The embedded package manifest is invalid.");
        ValidateManifest(manifest);

        var destination = Path.Combine(cacheRoot, $"embedded-{SanitizePathSegment(manifest.Version)}-{manifest.Sha256[..12]}.zip");
        await using var packageStream = assembly.GetManifestResourceStream(PackageResource)
            ?? throw new InvalidDataException("The embedded Manager package is missing.");
        await using var output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true);
        await packageStream.CopyToAsync(output, cancellationToken);
        return (destination, manifest);
    }

    private static async Task<(string ZipPath, PackageManifest Manifest)> DownloadReleaseAsync(
        InstallOptions options,
        string cacheRoot,
        Action<string> progress,
        CancellationToken cancellationToken)
    {
        var repository = options.GitHubRepository.Trim().Trim('/');
        if (!System.Text.RegularExpressions.Regex.IsMatch(repository, "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))
        {
            throw new InvalidOperationException("GitHub repository must use the owner/repository format.");
        }

        using var client = CreateGitHubClient(options.GitHubToken);
        var releasePath = options.ReleaseTag.Equals("latest", StringComparison.OrdinalIgnoreCase)
            ? $"https://api.github.com/repos/{repository}/releases/latest"
            : $"https://api.github.com/repos/{repository}/releases/tags/{Uri.EscapeDataString(options.ReleaseTag.Trim())}";
        using var releaseResponse = await client.GetAsync(releasePath, cancellationToken);
        if (!releaseResponse.IsSuccessStatusCode)
        {
            throw new HttpRequestException($"GitHub could not resolve that release ({(int)releaseResponse.StatusCode} {releaseResponse.ReasonPhrase}).");
        }
        await using var releaseStream = await releaseResponse.Content.ReadAsStreamAsync(cancellationToken);
        var release = await JsonSerializer.DeserializeAsync<GitHubRelease>(releaseStream, JsonOptions, cancellationToken)
            ?? throw new InvalidDataException("GitHub returned an invalid release response.");

        var zipAsset = release.Assets
            .Where(asset => asset.Name.StartsWith("manager-windows-", StringComparison.OrdinalIgnoreCase)
                && asset.Name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(asset => asset.CreatedAt)
            .FirstOrDefault()
            ?? throw new InvalidDataException("This release does not contain a manager-windows ZIP asset.");
        var manifestAsset = release.Assets.FirstOrDefault(asset =>
            asset.Name.Equals(zipAsset.Name + ".sha256.json", StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidDataException($"This release is missing {zipAsset.Name}.sha256.json.");

        progress($"Downloading {zipAsset.Name}...");
        var manifestBytes = await DownloadAssetAsync(client, manifestAsset, null, progress, cancellationToken);
        var manifest = JsonSerializer.Deserialize<PackageManifest>(manifestBytes, JsonOptions)
            ?? throw new InvalidDataException("The release package manifest is invalid.");
        ValidateManifest(manifest);
        if (!string.Equals(manifest.File, zipAsset.Name, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("The release manifest does not describe the selected ZIP asset.");
        }

        var destination = Path.Combine(cacheRoot, zipAsset.Name);
        var partial = destination + ".partial-" + Guid.NewGuid().ToString("N");
        try
        {
            await DownloadAssetAsync(client, zipAsset, partial, progress, cancellationToken);
            File.Move(partial, destination, true);
        }
        finally
        {
            if (File.Exists(partial)) File.Delete(partial);
        }
        return (destination, manifest);
    }

    private static HttpClient CreateGitHubClient(string token)
    {
        var client = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("ManagerSetup/2.0");
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        client.DefaultRequestHeaders.Add("X-GitHub-Api-Version", "2022-11-28");
        if (!string.IsNullOrWhiteSpace(token))
        {
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token.Trim());
        }
        return client;
    }

    private static async Task<byte[]> DownloadAssetAsync(
        HttpClient client,
        GitHubAsset asset,
        string? destination,
        Action<string> progress,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, asset.ApiUrl);
        request.Headers.Accept.Clear();
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
        if (destination is null)
        {
            using var memory = new MemoryStream();
            await input.CopyToAsync(memory, cancellationToken);
            return memory.ToArray();
        }

        await using var output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true);
        var buffer = new byte[81920];
        long received = 0;
        var total = response.Content.Headers.ContentLength;
        int read;
        while ((read = await input.ReadAsync(buffer, cancellationToken)) > 0)
        {
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            received += read;
            if (total > 0)
            {
                progress($"Downloading {asset.Name}: {received * 100 / total}%");
            }
        }
        return [];
    }

    private static async Task<string> ComputeSha256Async(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, true);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken));
    }

    private static async Task ExtractSafelyAsync(string zipPath, string destinationRoot, CancellationToken cancellationToken)
    {
        await using var input = new FileStream(zipPath, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, true);
        using var archive = new ZipArchive(input, ZipArchiveMode.Read);
        var normalizedRoot = Path.GetFullPath(destinationRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        foreach (var entry in archive.Entries)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var destination = Path.GetFullPath(Path.Combine(destinationRoot, entry.FullName));
            if (!destination.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("The package contains an unsafe path.");
            }
            if (string.IsNullOrEmpty(entry.Name))
            {
                Directory.CreateDirectory(destination);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            await using var entryStream = entry.Open();
            await using var output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true);
            await entryStream.CopyToAsync(output, cancellationToken);
        }
    }

    private static void ValidatePayload(string root)
    {
        foreach (var required in RequiredEntries)
        {
            var path = Path.Combine(root, required.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(path))
            {
                throw new InvalidDataException($"The Manager package is missing {required}.");
            }
        }
    }

    private static string SanitizePathSegment(string value)
    {
        var invalid = Path.GetInvalidFileNameChars().ToHashSet();
        var sanitized = new string(value.Select(character => invalid.Contains(character) ? '-' : character).ToArray());
        return string.IsNullOrWhiteSpace(sanitized) ? "unknown" : sanitized;
    }

    private static void ValidateManifest(PackageManifest manifest)
    {
        if (string.IsNullOrWhiteSpace(manifest.File)
            || string.IsNullOrWhiteSpace(manifest.Version)
            || !System.Text.RegularExpressions.Regex.IsMatch(manifest.Sha256, "^[A-Fa-f0-9]{64}$"))
        {
            throw new InvalidDataException("The package manifest is missing a valid file, version, or SHA-256 value.");
        }
    }

    private sealed class PackageManifest
    {
        [JsonPropertyName("file")] public string File { get; init; } = string.Empty;
        [JsonPropertyName("sha256")] public string Sha256 { get; init; } = string.Empty;
        [JsonPropertyName("version")] public string Version { get; init; } = string.Empty;
    }

    private sealed class GitHubRelease
    {
        [JsonPropertyName("assets")] public List<GitHubAsset> Assets { get; init; } = [];
    }

    private sealed class GitHubAsset
    {
        [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;
        [JsonPropertyName("url")] public string ApiUrl { get; init; } = string.Empty;
        [JsonPropertyName("created_at")] public DateTimeOffset CreatedAt { get; init; }
    }
}
