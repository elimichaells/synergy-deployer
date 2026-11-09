using System.Collections.Concurrent;
using System.Diagnostics;
using ManagerSetup;

var node = args[0];
foreach (var inherited in new[] { false, true })
{
    var output = new ConcurrentQueue<string>();
    var info = new ProcessStartInfo(node) { RedirectStandardOutput=true, RedirectStandardError=true, UseShellExecute=false, CreateNoWindow=true };
    info.ArgumentList.Add("-e");
    info.ArgumentList.Add(inherited
        ? "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit',detached:true});console.log('CHILD:'+c.pid);c.unref();console.error('fixture error');console.log('fixture done');process.exitCode=7"
        : "console.error('fixture error');console.log('fixture done');process.exitCode=7");
    using var process = new Process { StartInfo=info };
    var elapsed = Stopwatch.StartNew();
    process.Start();
    try
    {
        using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        var code = await InstallerProcess.CaptureAsync(process, output.Enqueue, limit.Token);
        if (code!=7 || !output.Contains("fixture done") || !output.Contains("ERROR: fixture error")) throw new Exception("Installer exit code or final output was lost");
        if (elapsed.Elapsed>TimeSpan.FromSeconds(8)) throw new Exception("Installer waited for its long-lived child");
        if (inherited)
        {
            using var child = Process.GetProcessById(int.Parse(output.Single(line=>line.StartsWith("CHILD:"))[6..]));
            if (child.HasExited) throw new Exception("The inherited-pipe fixture did not outlive setup");
        }
        Console.WriteLine("PASS: "+(inherited?"setup completes while a child retains output handles":"setup retains final output and failure status"));
    }
    finally
    {
        if (!process.HasExited) process.Kill(true);
        var childLine = output.SingleOrDefault(line=>line.StartsWith("CHILD:"));
        if(childLine is not null) { try { using var child = Process.GetProcessById(int.Parse(childLine[6..])); if(!child.HasExited)child.Kill(true); } catch(ArgumentException) {} }
    }
}
