using System.Diagnostics;
using System.IO;
using System.Text.Json;

namespace ManagerSetup;

internal static class InstallerRunner
{
    public static async Task RunAsync(
        PackagePayload payload,
        InstallOptions options,
        bool plan,
        Action<string> output,
        CancellationToken cancellationToken)
    {
        var sessionsRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "Manager", "InstallerSessions");
        Directory.CreateDirectory(sessionsRoot);
        var sessionRoot = Path.Combine(sessionsRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(sessionRoot);
        var configPath = Path.Combine(sessionRoot, "manager-install.json");

        var config = new Dictionary<string, object?>
        {
            ["ManagerDomain"] = options.ManagerDomain,
            ["ManagerPort"] = options.ManagerPort,
            ["ManagerRoot"] = options.ManagerRoot,
            ["WebRoot"] = options.WebRoot,
            ["AdminName"] = options.AdminName,
            ["AdminEmail"] = options.AdminEmail,
            ["DbHost"] = "127.0.0.1",
            ["DbPort"] = 5432,
            ["DbName"] = "server_manager",
            ["DbAdminUser"] = "postgres",
            ["DbAppUser"] = "manager_app",
            ["InstallPostgreSQL"] = options.InstallPostgreSql,
            ["InstallApplicationPostgreSQL"] = options.InstallApplicationPostgreSql,
            ["AppDbPort"] = 5433,
            ["AppDbAdminUser"] = "manager_project_admin",
            ["AppDbDataDirectory"] = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Manager", "postgres-app"),
            ["AppDbServiceName"] = "ManagerPostgreSQLApplications",
            ["AppDbConnectionName"] = "Managed application PostgreSQL",
            ["InstallPgweb"] = options.InstallPgweb,
            ["InstallLatestNpm"] = options.InstallLatestNpm,
            ["OptionalRuntimes"] = options.OptionalRuntimes,
            ["OptionalDatabaseEngines"] = options.OptionalDatabaseEngines,
            ["PostgreSqlPackage"] = "postgresql18"
        };

        await File.WriteAllTextAsync(configPath,
            JsonSerializer.Serialize(config, new JsonSerializerOptions { WriteIndented = true }), cancellationToken);

        try
        {
            var scriptPath = Path.Combine(payload.RootPath, "scripts", "install-manager.ps1");
            var powerShell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell", "v1.0", "powershell.exe");
            if (!File.Exists(powerShell)) powerShell = "powershell.exe";

            var startInfo = new ProcessStartInfo(powerShell)
            {
                WorkingDirectory = payload.RootPath,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            startInfo.ArgumentList.Add("-NoLogo");
            startInfo.ArgumentList.Add("-NoProfile");
            startInfo.ArgumentList.Add("-NonInteractive");
            startInfo.ArgumentList.Add("-ExecutionPolicy");
            startInfo.ArgumentList.Add("Bypass");
            startInfo.ArgumentList.Add("-File");
            startInfo.ArgumentList.Add(scriptPath);
            startInfo.ArgumentList.Add("-ConfigPath");
            startInfo.ArgumentList.Add(configPath);
            startInfo.ArgumentList.Add("-Unattended");
            if (plan) startInfo.ArgumentList.Add("-Plan");

            startInfo.Environment["MANAGER_INSTALL_ADMINPASSWORD"] = options.AdminPassword;
            startInfo.Environment["MANAGER_INSTALL_DBADMINPASSWORD"] = options.DbAdminPassword;
            startInfo.Environment["MANAGER_INSTALL_DBAPPPASSWORD"] = options.DbAppPassword;
            startInfo.Environment["MANAGER_INSTALL_APPDBADMINPASSWORD"] = options.AppDbAdminPassword;

            using var process = new Process { StartInfo = startInfo };
            if (!process.Start()) throw new InvalidOperationException("PowerShell could not start the Manager installer.");
            using var registration = cancellationToken.Register(() =>
            {
                try
                {
                    if (!process.HasExited) process.Kill(true);
                }
                catch
                {
                    // The process may finish while cancellation is being delivered.
                }
            });

            var standardOutput = PumpAsync(process.StandardOutput, output, cancellationToken);
            var standardError = PumpAsync(process.StandardError, line => output("ERROR: " + line), cancellationToken);
            await Task.WhenAll(standardOutput, standardError, process.WaitForExitAsync(cancellationToken));
            if (process.ExitCode != 0)
            {
                throw new InvalidOperationException($"Manager provisioning exited with code {process.ExitCode}.");
            }
        }
        finally
        {
            if (Directory.Exists(sessionRoot)) Directory.Delete(sessionRoot, true);
        }
    }

    private static async Task PumpAsync(StreamReader reader, Action<string> output, CancellationToken cancellationToken)
    {
        while (await reader.ReadLineAsync(cancellationToken) is { } line)
        {
            output(line);
        }
    }
}
