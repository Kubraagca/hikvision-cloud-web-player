using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using System.Text.Json;
using HikSdk.Interop;

namespace HikSdk.ProvisioningCli;

internal static class DiagnosticsReporter
{
    private static readonly string[] RequiredDlls =
    [
        "HCNetSDK.dll",
        "HCCore.dll",
        "hpr.dll",
        "zlib1.dll",
        "libcrypto-1_1-x64.dll",
        "libssl-1_1-x64.dll"
    ];

    public static async Task<int> RunAsync()
    {
        var baseDirectory = AppContext.BaseDirectory;
        var sdkRuntime = await InspectSdkRuntimeAsync(baseDirectory);
        var networkAdapters = InspectNetworkAdapters();
        var firewallProfiles = await InspectFirewallProfilesAsync();

        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new
        {
            success = true,
            generatedAtUtc = DateTimeOffset.UtcNow,
            runtime = new
            {
                baseDirectory,
                processArchitecture = RuntimeInformation.ProcessArchitecture.ToString(),
                osArchitecture = RuntimeInformation.OSArchitecture.ToString(),
                framework = RuntimeInformation.FrameworkDescription,
                osDescription = RuntimeInformation.OSDescription
            },
            sdk = sdkRuntime,
            networkAdapters,
            firewallProfiles
        }, new JsonSerializerOptions
        {
            WriteIndented = true
        }));

        return 0;
    }

    private static async Task<object> InspectSdkRuntimeAsync(string baseDirectory)
    {
        var dependencies = RequiredDlls
            .Select(dllName => InspectDependency(Path.Combine(baseDirectory, dllName)))
            .ToArray();

        var comDirectory = Path.Combine(baseDirectory, "HCNetSDKCom");
        var initStatus = await ProbeSdkInitializationAsync();

        return new
        {
            comDirectory = new
            {
                path = comDirectory,
                exists = Directory.Exists(comDirectory)
            },
            dependencies,
            initStatus
        };
    }

    private static object InspectDependency(string path)
    {
        var exists = File.Exists(path);
        string? fileVersion = null;
        string? productVersion = null;
        string? architecture = null;
        bool loaded = false;
        string? loadError = null;

        if (exists)
        {
            var versionInfo = FileVersionInfo.GetVersionInfo(path);
            fileVersion = versionInfo.FileVersion;
            productVersion = versionInfo.ProductVersion;
            architecture = ReadPeArchitecture(path);

            if (NativeLibrary.TryLoad(path, out var handle))
            {
                loaded = true;
                NativeLibrary.Free(handle);
            }
            else
            {
                loadError = "NativeLibrary.TryLoad returned false.";
            }
        }

        return new
        {
            file = Path.GetFileName(path),
            path,
            exists,
            architecture,
            fileVersion,
            productVersion,
            loaded,
            loadError
        };
    }

    private static async Task<object> ProbeSdkInitializationAsync()
    {
        try
        {
            SadpInteropValidator.ThrowIfInvalid();
        }
        catch (Exception exception)
        {
            return new
            {
                initialized = false,
                marshalValidation = new
                {
                    success = false,
                    error = exception.Message
                }
            };
        }

        try
        {
            HikSdkSession.ConfigureSdkInitPaths();
        }
        catch (Exception exception)
        {
            return new
            {
                initialized = false,
                marshalValidation = new { success = true },
                setSdkInitCfg = new
                {
                    success = false,
                    error = exception.Message
                }
            };
        }

        if (!HikSdkNative.NET_DVR_Init())
        {
            var error = HikSdkSession.CaptureLastError();
            return new
            {
                initialized = false,
                marshalValidation = new { success = true },
                setSdkInitCfg = new { success = true },
                initCall = new
                {
                    success = false,
                    errorCode = error.ErrorCode,
                    errorSymbol = error.ErrorSymbol,
                    errorMessage = error.ErrorMessage
                }
            };
        }

        try
        {
            var sdkVersion = HikSdkNative.NET_DVR_GetSDKVersion();
            var buildVersion = HikSdkNative.NET_DVR_GetSDKBuildVersion();

            return new
            {
                initialized = true,
                marshalValidation = new { success = true },
                setSdkInitCfg = new { success = true },
                initCall = new { success = true },
                sdkVersion = FormatSdkVersion(sdkVersion),
                sdkVersionRaw = sdkVersion,
                sdkBuildVersion = buildVersion
            };
        }
        finally
        {
            HikSdkNative.NET_DVR_Cleanup();
        }
    }

    private static object[] InspectNetworkAdapters()
    {
        return NetworkInterface.GetAllNetworkInterfaces()
            .Where(adapter =>
                adapter.OperationalStatus == OperationalStatus.Up &&
                adapter.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .Select(adapter =>
            {
                var properties = adapter.GetIPProperties();
                var ipv4Addresses = properties.UnicastAddresses
                    .Where(address => address.Address.AddressFamily == AddressFamily.InterNetwork)
                    .Select(address => new
                    {
                        address = address.Address.ToString(),
                        subnetMask = address.IPv4Mask?.ToString() ?? string.Empty,
                        prefixLength = address.PrefixLength
                    })
                    .ToArray();

                return new
                {
                    adapter.Name,
                    adapter.Description,
                    adapter.NetworkInterfaceType,
                    adapter.OperationalStatus,
                    macAddress = FormatMac(adapter.GetPhysicalAddress()),
                    ipv4Addresses
                };
            })
            .Where(adapter => adapter.ipv4Addresses.Length > 0)
            .Cast<object>()
            .ToArray();
    }

    private static async Task<object> InspectFirewallProfilesAsync()
    {
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = "powershell",
                Arguments = "-NoProfile -Command \"Get-NetFirewallProfile | Select-Object Name,Enabled,DefaultInboundAction,DefaultOutboundAction | ConvertTo-Json -Compress\"",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            using var process = Process.Start(startInfo);
            if (process is null)
            {
                return new
                {
                    success = false,
                    error = "PowerShell process could not be started."
                };
            }

            var stdout = await process.StandardOutput.ReadToEndAsync();
            var stderr = await process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync();

            if (process.ExitCode != 0)
            {
                return new
                {
                    success = false,
                    error = string.IsNullOrWhiteSpace(stderr) ? $"Get-NetFirewallProfile exited with code {process.ExitCode}." : stderr.Trim()
                };
            }

            var parsed = JsonSerializer.Deserialize<JsonElement>(stdout);
            return new
            {
                success = true,
                profiles = parsed
            };
        }
        catch (Exception exception)
        {
            return new
            {
                success = false,
                error = exception.Message
            };
        }
    }

    private static string ReadPeArchitecture(string path)
    {
        using var stream = File.OpenRead(path);
        using var reader = new PEReader(stream);
        return reader.PEHeaders.CoffHeader.Machine switch
        {
            Machine.Amd64 => "x64",
            Machine.I386 => "x86",
            Machine.Arm64 => "arm64",
            _ => reader.PEHeaders.CoffHeader.Machine.ToString()
        };
    }

    private static string FormatSdkVersion(uint version)
    {
        var major = (version >> 24) & 0xFF;
        var minor = (version >> 16) & 0xFF;
        var patch = (version >> 8) & 0xFF;
        var build = version & 0xFF;
        return $"{major}.{minor}.{patch}.{build}";
    }

    private static string FormatMac(PhysicalAddress address)
    {
        var bytes = address.GetAddressBytes();
        return bytes.Length == 0
            ? string.Empty
            : string.Join("-", bytes.Select(b => b.ToString("X2")));
    }
}
