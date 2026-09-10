using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net.Mail;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace ManagerSetup;

public partial class MainWindow : Window
{
    private readonly Grid[] _panels;
    private readonly Border[] _stepBorders;
    private readonly TextBlock[] _stepTexts;
    private readonly string[] _titles =
    [
        "Choose the Manager package",
        "Configure this server",
        "Create the Manager administrator",
        "Select managed components",
        "Review the installation",
        "Preflight and installation"
    ];
    private readonly string[] _subtitles =
    [
        "Install from a verified GitHub release or use the package embedded in this setup file.",
        "Manager runs privately behind Caddy, which provides the public HTTPS endpoint.",
        "These credentials initialize Manager and its isolated database roles.",
        "Core dependencies are automatic; choose the runtimes and database engines projects may need.",
        "No changes are made until package verification and the read-only preflight succeed.",
        "Follow package verification, server checks, and provisioning in real time."
    ];

    private int _currentStep;
    private bool _running;
    private bool _preflightPassed;
    private bool _installationComplete;
    private PackagePayload? _payload;
    private CancellationTokenSource? _operationCancellation;
    private readonly string _dbAppPassword = CreateSecret();
    private readonly string _appDbAdminPassword = CreateSecret();

    public MainWindow()
    {
        InitializeComponent();
        _panels = [SourcePanel, ServerPanel, AccountPanel, ComponentsPanel, ReviewPanel, InstallPanel];
        _stepBorders = [StepSource, StepServer, StepAccount, StepComponents, StepReview, StepInstall];
        _stepTexts = [StepSourceText, StepServerText, StepAccountText, StepComponentsText, StepReviewText, StepInstallText];
        UpdateSourceMode();
        UpdateStep();
    }

    private void SourceMode_Checked(object sender, RoutedEventArgs e)
    {
        if (!IsInitialized) return;
        UpdateSourceMode();
        InvalidatePreflight();
    }

    private void UpdateSourceMode()
    {
        if (OnlineFields is null || OnlineSourceRadio is null) return;
        OnlineFields.IsEnabled = OnlineSourceRadio.IsChecked == true;
        OnlineFields.Opacity = OnlineFields.IsEnabled ? 1 : 0.45;
    }

    private void BackButton_Click(object sender, RoutedEventArgs e)
    {
        if (_running || _currentStep == 0) return;
        if (_currentStep == 5 && _installationComplete) return;
        _currentStep--;
        InvalidatePreflight();
        UpdateStep();
    }

    private async void NextButton_Click(object sender, RoutedEventArgs e)
    {
        if (_running) return;

        if (_installationComplete)
        {
            Process.Start(new ProcessStartInfo($"https://{DomainTextBox.Text.Trim()}") { UseShellExecute = true });
            return;
        }

        if (_currentStep == 5)
        {
            if (_preflightPassed) await RunInstallationAsync();
            return;
        }

        if (!ValidateStep(_currentStep)) return;
        if (_currentStep == 4)
        {
            _currentStep = 5;
            UpdateStep();
            await RunPreflightAsync();
            return;
        }

        _currentStep++;
        InvalidatePreflight();
        if (_currentStep == 4) PopulateReview();
        UpdateStep();
    }

    private void CancelOperationButton_Click(object sender, RoutedEventArgs e)
    {
        _operationCancellation?.Cancel();
        AppendLog("Cancellation requested. Waiting for the active process to stop...");
    }

    private async void UseEmbeddedPackageButton_Click(object sender, RoutedEventArgs e)
    {
        if (_running || _installationComplete) return;
        OfflineSourceRadio.IsChecked = true;
        InvalidatePreflight();
        PopulateReview();
        await RunPreflightAsync();
    }

    private async Task RunPreflightAsync()
    {
        var options = ReadOptions();
        InvalidatePreflight();
        UseEmbeddedPackageButton.Visibility = Visibility.Collapsed;
        SetRunning(true);
        InstallStatusText.Text = "Verifying the Manager package";
        InstallDetailText.Text = "No server changes are being made.";
        InstallLogTextBox.Clear();
        AppendLog($"Source: {(options.UseOnlinePackage ? "GitHub Releases" : "embedded offline package")}");

        try
        {
            _operationCancellation = new CancellationTokenSource();
            _payload = await PackageResolver.ResolveAsync(options, AppendLog, _operationCancellation.Token);
            AppendLog($"Package source: {_payload.Source}");
            AppendLog($"SHA-256: {_payload.Sha256}");
            AppendLog(string.Empty);
            InstallStatusText.Text = "Running server preflight";
            await InstallerRunner.RunAsync(_payload, options, true, AppendLog, _operationCancellation.Token);
            _preflightPassed = true;
            InstallStatusText.Text = "Preflight passed";
            InstallDetailText.Text = $"Manager {_payload.Version} is verified. Review the log, then begin installation.";
            AppendLog(string.Empty);
            AppendLog("PASS: No changes were made. Installation is ready.");
        }
        catch (OperationCanceledException)
        {
            InstallStatusText.Text = "Preflight cancelled";
            InstallDetailText.Text = "You can return to review or run the preflight again.";
            AppendLog("CANCELLED: Preflight was stopped.");
        }
        catch (Exception exception)
        {
            InstallStatusText.Text = "Preflight failed";
            InstallDetailText.Text = exception.Message;
            AppendLog("FAIL: " + exception.Message);
            if (options.UseOnlinePackage && exception is HttpRequestException { StatusCode: HttpStatusCode.NotFound })
                UseEmbeddedPackageButton.Visibility = Visibility.Visible;
        }
        finally
        {
            SetRunning(false);
            UpdateStep();
        }
    }

    private async Task RunInstallationAsync()
    {
        if (_payload is null || !_preflightPassed) return;
        var confirmation = MessageBox.Show(
            $"Install Manager {_payload.Version} on this server now?\n\nThe setup log will remain visible throughout provisioning.",
            "Begin Manager installation", MessageBoxButton.YesNo, MessageBoxImage.Question);
        if (confirmation != MessageBoxResult.Yes) return;

        var options = ReadOptions();
        SetRunning(true);
        InstallStatusText.Text = "Installing Manager";
        InstallDetailText.Text = "Dependencies, services, databases, Manager, and Caddy are being configured.";
        AppendLog(string.Empty);
        AppendLog($"Starting Manager {_payload.Version} installation...");

        try
        {
            _operationCancellation = new CancellationTokenSource();
            await InstallerRunner.RunAsync(_payload, options, false, AppendLog, _operationCancellation.Token);
            _installationComplete = true;
            InstallStatusText.Text = "Manager installation completed";
            InstallDetailText.Text = $"Manager is available at https://{options.ManagerDomain}. The detailed report is in C:\\ProgramData\\Manager\\install-report.json.";
            AppendLog(string.Empty);
            AppendLog("PASS: Installation and final health verification completed.");
        }
        catch (OperationCanceledException)
        {
            InstallStatusText.Text = "Installation cancelled";
            InstallDetailText.Text = "Provisioning was interrupted. Review the log before retrying; completed idempotent steps will be detected.";
            AppendLog("CANCELLED: Installation was stopped.");
        }
        catch (Exception exception)
        {
            InstallStatusText.Text = "Installation needs attention";
            InstallDetailText.Text = exception.Message + " Review the log and retry after correcting the cause.";
            AppendLog("FAIL: " + exception.Message);
        }
        finally
        {
            SetRunning(false);
            UpdateStep();
        }
    }

    private void SetRunning(bool running)
    {
        _running = running;
        InstallProgressBar.IsIndeterminate = running;
        InstallProgressBar.Visibility = running ? Visibility.Visible : Visibility.Hidden;
        CancelOperationButton.Visibility = running ? Visibility.Visible : Visibility.Collapsed;
        BackButton.IsEnabled = !running;
        NextButton.IsEnabled = !running && (_currentStep != 5 || _preflightPassed || _installationComplete);
    }

    private void AppendLog(string line)
    {
        Dispatcher.Invoke(() =>
        {
            InstallLogTextBox.AppendText(line + Environment.NewLine);
            InstallLogTextBox.ScrollToEnd();
        });
    }

    private void DatabaseEngine_Checked(object sender, RoutedEventArgs e)
    {
        if (sender == MySqlCheckBox && MariaDbCheckBox is not null) MariaDbCheckBox.IsChecked = false;
        if (sender == MariaDbCheckBox && MySqlCheckBox is not null) MySqlCheckBox.IsChecked = false;
    }

    private bool ValidateStep(int step)
    {
        string? error = null;
        switch (step)
        {
            case 0:
                if (OnlineSourceRadio.IsChecked == true
                    && !Regex.IsMatch(RepositoryTextBox.Text.Trim(), "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))
                    error = "Enter the GitHub repository as owner/repository.";
                else if (OnlineSourceRadio.IsChecked == true && string.IsNullOrWhiteSpace(ReleaseTagTextBox.Text))
                    error = "Enter latest or a GitHub release tag.";
                break;
            case 1:
                if (!Regex.IsMatch(DomainTextBox.Text.Trim(), "^(?=.{3,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}$"))
                    error = "Enter a valid fully qualified domain name without https:// or a path.";
                else if (!int.TryParse(PortTextBox.Text, out var port) || port is < 1 or > 65535)
                    error = "Manager port must be between 1 and 65535.";
                else if (!Path.IsPathRooted(ManagerRootTextBox.Text) || !Path.IsPathRooted(WebRootTextBox.Text))
                    error = "Manager and web directories must be absolute Windows paths.";
                break;
            case 2:
                if (string.IsNullOrWhiteSpace(AdminNameTextBox.Text)) error = "Enter the initial administrator name.";
                else if (!IsValidEmail(AdminEmailTextBox.Text.Trim())) error = "Enter a valid administrator email address.";
                else if (AdminPasswordBox.Password.Length < 12) error = "The Manager administrator password must contain at least 12 characters.";
                else if (AdminPasswordBox.Password != AdminPasswordConfirmBox.Password) error = "The administrator passwords do not match.";
                else if (DbAdminPasswordBox.Password.Length < 8) error = "Enter the PostgreSQL administrator password (at least 8 characters).";
                break;
        }

        if (error is null) return true;
        MessageBox.Show(error, "Check setup details", MessageBoxButton.OK, MessageBoxImage.Warning);
        return false;
    }

    private static bool IsValidEmail(string value)
    {
        try { return new MailAddress(value).Address == value; }
        catch { return false; }
    }

    private InstallOptions ReadOptions()
    {
        var runtimes = new List<string>();
        if (GoCheckBox.IsChecked == true) runtimes.Add("go");
        if (PhpCheckBox.IsChecked == true) runtimes.Add("php");
        if (ComposerCheckBox.IsChecked == true) runtimes.Add("composer");
        var engines = new List<string>();
        if (MySqlCheckBox.IsChecked == true) engines.Add("mysql");
        if (MariaDbCheckBox.IsChecked == true) engines.Add("mariadb");
        if (MongoDbCheckBox.IsChecked == true) engines.Add("mongodb");
        if (SqlServerCheckBox.IsChecked == true) engines.Add("sqlserver");

        return new InstallOptions
        {
            UseOnlinePackage = OnlineSourceRadio.IsChecked == true,
            GitHubRepository = RepositoryTextBox.Text.Trim(),
            ReleaseTag = ReleaseTagTextBox.Text.Trim(),
            GitHubToken = GitHubTokenPasswordBox.Password,
            ManagerDomain = DomainTextBox.Text.Trim().ToLowerInvariant(),
            ManagerPort = int.TryParse(PortTextBox.Text, out var port) ? port : 4000,
            ManagerRoot = ManagerRootTextBox.Text.Trim(),
            WebRoot = WebRootTextBox.Text.Trim(),
            AdminName = AdminNameTextBox.Text.Trim(),
            AdminEmail = AdminEmailTextBox.Text.Trim().ToLowerInvariant(),
            AdminPassword = AdminPasswordBox.Password,
            DbAdminPassword = DbAdminPasswordBox.Password,
            DbAppPassword = _dbAppPassword,
            AppDbAdminPassword = _appDbAdminPassword,
            InstallPostgreSql = InstallPostgresCheckBox.IsChecked == true,
            InstallApplicationPostgreSql = InstallAppPostgresCheckBox.IsChecked == true,
            InstallPgweb = InstallPgwebCheckBox.IsChecked == true,
            InstallLatestNpm = LatestNpmCheckBox.IsChecked == true,
            OptionalRuntimes = runtimes,
            OptionalDatabaseEngines = engines
        };
    }

    private void PopulateReview()
    {
        var options = ReadOptions();
        var source = options.UseOnlinePackage
            ? $"GitHub release: {options.GitHubRepository} ({options.ReleaseTag})"
            : "Embedded offline package";
        ReviewTextBox.Text = string.Join(Environment.NewLine,
        [
            $"PACKAGE     {source}",
            $"DOMAIN      https://{options.ManagerDomain}",
            $"APP PORT    127.0.0.1:{options.ManagerPort}",
            $"INSTALL     {options.ManagerRoot}",
            $"WEB ROOT    {options.WebRoot}",
            $"ADMIN       {options.AdminName} <{options.AdminEmail}>",
            string.Empty,
            $"CONTROL DB  PostgreSQL 127.0.0.1:5432 ({Enabled(options.InstallPostgreSql)})",
            $"PROJECT DB  PostgreSQL 127.0.0.1:5433 ({Enabled(options.InstallApplicationPostgreSql)})",
            $"PGWEB       {Enabled(options.InstallPgweb)}",
            $"PHPMYADMIN  {Enabled(options.OptionalDatabaseEngines.Any(engine => engine is "mysql" or "mariadb"))}",
            $"LATEST NPM  {Enabled(options.InstallLatestNpm)}",
            $"RUNTIMES    {ListOrNone(options.OptionalRuntimes)}",
            $"EXTRA DBS   {ListOrNone(options.OptionalDatabaseEngines)}",
            string.Empty,
            "SECURITY     Database ports remain private; secrets are not written to setup JSON or process arguments."
        ]);
    }

    private static string Enabled(bool value) => value ? "enabled" : "disabled";
    private static string ListOrNone(IReadOnlyList<string> values) => values.Count == 0 ? "none" : string.Join(", ", values);

    private static string CreateSecret()
    {
        return Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private void InvalidatePreflight()
    {
        _preflightPassed = false;
        _payload = null;
    }

    private void UpdateStep()
    {
        if (_currentStep != 5) UseEmbeddedPackageButton.Visibility = Visibility.Collapsed;
        for (var index = 0; index < _panels.Length; index++)
        {
            _panels[index].Visibility = index == _currentStep ? Visibility.Visible : Visibility.Collapsed;
            var active = index == _currentStep;
            var complete = index < _currentStep;
            _stepBorders[index].Background = active ? new SolidColorBrush(Color.FromRgb(47, 61, 73)) : Brushes.Transparent;
            _stepTexts[index].Foreground = active ? Brushes.White
                : complete ? new SolidColorBrush(Color.FromRgb(110, 231, 183))
                : new SolidColorBrush(Color.FromRgb(170, 180, 191));
            _stepTexts[index].FontWeight = active ? FontWeights.SemiBold : FontWeights.Normal;
        }

        PageTitle.Text = _titles[_currentStep];
        PageSubtitle.Text = _subtitles[_currentStep];
        BackButton.IsEnabled = !_running && _currentStep > 0 && !_installationComplete;
        NextButton.IsEnabled = !_running && (_currentStep != 5 || _preflightPassed || _installationComplete);
        NextButton.Content = _currentStep switch
        {
            4 => "Run preflight",
            5 when _installationComplete => "Open Manager",
            5 when _preflightPassed => "Install Manager",
            5 => "Preflight required",
            _ => "Continue"
        };
    }

    private void Window_Closing(object? sender, CancelEventArgs e)
    {
        if (!_running) return;
        var result = MessageBox.Show("A setup operation is still running. Cancel it and close Manager Setup?",
            "Setup is running", MessageBoxButton.YesNo, MessageBoxImage.Warning);
        if (result != MessageBoxResult.Yes)
        {
            e.Cancel = true;
            return;
        }
        _operationCancellation?.Cancel();
    }
}
