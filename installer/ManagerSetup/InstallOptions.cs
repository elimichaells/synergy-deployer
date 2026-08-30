namespace ManagerSetup;

internal sealed class InstallOptions
{
    public bool UseOnlinePackage { get; init; }
    public string GitHubRepository { get; init; } = "elimichaells/synergy-deployer";
    public string ReleaseTag { get; init; } = "latest";
    public string GitHubToken { get; init; } = string.Empty;
    public string ManagerDomain { get; init; } = string.Empty;
    public int ManagerPort { get; init; } = 4000;
    public string ManagerRoot { get; init; } = @"C:\web\manager";
    public string WebRoot { get; init; } = @"C:\web";
    public string AdminName { get; init; } = "Administrator";
    public string AdminEmail { get; init; } = string.Empty;
    public string AdminPassword { get; init; } = string.Empty;
    public string DbAdminPassword { get; init; } = string.Empty;
    public string DbAppPassword { get; init; } = string.Empty;
    public string AppDbAdminPassword { get; init; } = string.Empty;
    public bool InstallPostgreSql { get; init; } = true;
    public bool InstallApplicationPostgreSql { get; init; } = true;
    public bool InstallPgweb { get; init; } = true;
    public bool InstallLatestNpm { get; init; } = true;
    public IReadOnlyList<string> OptionalRuntimes { get; init; } = [];
    public IReadOnlyList<string> OptionalDatabaseEngines { get; init; } = [];
}

internal sealed record PackagePayload(string RootPath, string Version, string Sha256, string Source);
internal sealed record PackageValidation(string Version, string Sha256);
