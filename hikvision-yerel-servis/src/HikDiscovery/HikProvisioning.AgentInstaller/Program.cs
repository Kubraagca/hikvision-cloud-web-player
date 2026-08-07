using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
using System.Linq;

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        ApplicationConfiguration.Initialize();

        try
        {
            var targetDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "HikProvisioningAgent");

            var tempRoot = Path.Combine(Path.GetTempPath(), "HikProvisioningAgentSetup", Guid.NewGuid().ToString("n"));
            Directory.CreateDirectory(tempRoot);

            try
            {
                var payloadZipPath = Path.Combine(tempRoot, "payload.zip");
                ExtractEmbeddedPayload(payloadZipPath);

                if (Directory.Exists(targetDir))
                {
                    TryStopRunningAgent(targetDir);
                    Directory.Delete(targetDir, recursive: true);
                }

                Directory.CreateDirectory(targetDir);
                ZipFile.ExtractToDirectory(payloadZipPath, targetDir, overwriteFiles: true);

                CreateStartScripts(targetDir);
                CreateShortcuts(targetDir);
                StartAgent(targetDir);

                MessageBox.Show(
                    "Kurulum tamamlandi.\n\nYer: " + targetDir,
                    "HikProvisioning Agent",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);

                return 0;
            }
            finally
            {
                try
                {
                    if (Directory.Exists(tempRoot))
                    {
                        Directory.Delete(tempRoot, recursive: true);
                    }
                }
                catch
                {
                }
            }
        }
        catch (Exception exception)
        {
            MessageBox.Show(
                "Kurulum basarisiz.\n\n" + exception.Message,
                "HikProvisioning Agent",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }

    private static void ExtractEmbeddedPayload(string destinationPath)
    {
        var assembly = Assembly.GetExecutingAssembly();
        using var stream = assembly.GetManifestResourceStream("payload.zip")
            ?? throw new InvalidOperationException("Installer payload.zip kaynagini bulamadi.");
        using var file = File.Create(destinationPath);
        stream.CopyTo(file);
    }

    private static void TryStopRunningAgent(string targetDir)
    {
        foreach (var process in System.Diagnostics.Process.GetProcessesByName("HikProvisioning.Agent"))
        {
            try
            {
                var processPath = process.MainModule?.FileName ?? string.Empty;
                if (processPath.StartsWith(targetDir, StringComparison.OrdinalIgnoreCase))
                {
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(5000);
                }
            }
            catch
            {
            }
        }
    }

    private static void CreateStartScripts(string targetDir)
    {
        var cmdPath = Path.Combine(targetDir, "start-agent.cmd");
        var cmdContent = """
@echo off
cd /d %~dp0
start "" "%~dp0HikProvisioning.Agent.exe"
""";
        File.WriteAllText(cmdPath, cmdContent, Encoding.ASCII);

        var installReadmePath = Path.Combine(targetDir, "README.txt");
        var readme = """
HikProvisioning.Agent

1. start-agent.cmd ile agent'i baslatabilirsiniz.
2. Agent su adreste dinler:
   http://127.0.0.1:47831
3. Web arayuzunden yerel kamera kurulumunu acin.
""";
        File.WriteAllText(installReadmePath, readme, Encoding.ASCII);
    }

    private static void CreateShortcuts(string targetDir)
    {
        var startCmdPath = Path.Combine(targetDir, "start-agent.cmd");
        var desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        var startupDir = Environment.GetFolderPath(Environment.SpecialFolder.Startup);

        CreateShortcut(Path.Combine(desktopDir, "Hikvision Kamera Yardimcisi.lnk"), startCmdPath, targetDir);
        CreateShortcut(Path.Combine(startupDir, "Hikvision Kamera Yardimcisi.lnk"), startCmdPath, targetDir);
    }

    private static void CreateShortcut(string shortcutPath, string targetPath, string workingDirectory)
    {
        var shellType = Type.GetTypeFromProgID("WScript.Shell")
            ?? throw new InvalidOperationException("WScript.Shell olusturulamadi.");
        dynamic shell = Activator.CreateInstance(shellType)!;
        try
        {
            dynamic shortcut = shell.CreateShortcut(shortcutPath);
            shortcut.TargetPath = targetPath;
            shortcut.WorkingDirectory = workingDirectory;
            shortcut.Save();
        }
        finally
        {
            try
            {
                System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);
            }
            catch
            {
            }
        }
    }

    private static void StartAgent(string targetDir)
    {
        var exePath = LocateAgentExecutable(targetDir);
        if (exePath is null)
        {
            throw new FileNotFoundException("Kurulan agent exe bulunamadi.", Path.Combine(targetDir, "HikProvisioning.Agent.exe"));
        }

        var startInfo = new System.Diagnostics.ProcessStartInfo
        {
            FileName = exePath,
            WorkingDirectory = Path.GetDirectoryName(exePath) ?? targetDir,
            UseShellExecute = true
        };

        System.Diagnostics.Process.Start(startInfo);
    }

    private static string? LocateAgentExecutable(string targetDir)
    {
        var rootExePath = Path.Combine(targetDir, "HikProvisioning.Agent.exe");
        if (File.Exists(rootExePath))
        {
            return rootExePath;
        }

        return Directory
            .EnumerateFiles(targetDir, "HikProvisioning.Agent.exe", SearchOption.AllDirectories)
            .OrderBy(path => path.Count(character => character == Path.DirectorySeparatorChar || character == Path.AltDirectorySeparatorChar))
            .FirstOrDefault();
    }
}
