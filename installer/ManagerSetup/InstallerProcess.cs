using System.Diagnostics;
using System.IO;

namespace ManagerSetup;

internal static class InstallerProcess
{
    internal static async Task<int> CaptureAsync(Process process, Action<string> output, CancellationToken cancellationToken)
    {
        using var capture = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var pumps = Task.WhenAll(PumpAsync(process.StandardOutput, output, capture.Token),
            PumpAsync(process.StandardError, line => output("ERROR: " + line), capture.Token));
        try
        {
            // Manual stream readers let this await the installer itself. A PM2
            // daemon may retain inherited pipe handles after PowerShell exits.
            await process.WaitForExitAsync(cancellationToken);
            if (await Task.WhenAny(pumps, Task.Delay(TimeSpan.FromSeconds(2), cancellationToken)) == pumps)
                await pumps;
            cancellationToken.ThrowIfCancellationRequested();
            return process.ExitCode;
        }
        finally
        {
            capture.Cancel();
            // Disposal closes any inherited pipes still being read. Observe their
            // eventual exceptions without making a long-lived child block setup.
            _ = pumps.ContinueWith(task => { _ = task.Exception; }, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        }
    }

    private static async Task PumpAsync(StreamReader reader, Action<string> output, CancellationToken token)
    {
        while (await reader.ReadLineAsync(token) is { } line)
        {
            token.ThrowIfCancellationRequested();
            output(line);
        }
    }
}
