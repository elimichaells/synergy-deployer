using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Windows;

namespace ManagerSetup;

public partial class App : Application
{
    private async void Application_Startup(object sender, StartupEventArgs e)
    {
        if (e.Args.Contains("--smoke-test", StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                var result = await PackageResolver.ValidateEmbeddedPackageAsync();
                var message = $"PASS: embedded Manager {result.Version} package verified ({result.Sha256}).";
                var reportIndex = Array.FindIndex(e.Args, argument => argument.Equals("--smoke-report", StringComparison.OrdinalIgnoreCase));
                if (reportIndex >= 0 && reportIndex + 1 < e.Args.Length)
                {
                    await File.WriteAllTextAsync(e.Args[reportIndex + 1], message);
                }
                Shutdown(0);
            }
            catch (Exception exception)
            {
                var reportIndex = Array.FindIndex(e.Args, argument => argument.Equals("--smoke-report", StringComparison.OrdinalIgnoreCase));
                if (reportIndex >= 0 && reportIndex + 1 < e.Args.Length)
                {
                    await File.WriteAllTextAsync(e.Args[reportIndex + 1], $"FAIL: {exception.Message}");
                }
                Shutdown(1);
            }
            return;
        }

        if (!IsAdministrator())
        {
            try
            {
                var processPath = Environment.ProcessPath
                    ?? throw new InvalidOperationException("Could not determine the setup executable path.");
                Process.Start(new ProcessStartInfo(processPath)
                {
                    UseShellExecute = true,
                    Verb = "runas"
                });
            }
            catch (System.ComponentModel.Win32Exception)
            {
                MessageBox.Show("Manager Setup requires administrator access to install Windows services.",
                    "Administrator access required", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
            Shutdown();
            return;
        }

        var window = new MainWindow();
        MainWindow = window;
        window.Show();
    }

    private static bool IsAdministrator()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }
}
