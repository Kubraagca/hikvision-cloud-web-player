using System.Net;
using System.Text.Json;
using HikSdk.Interop;

namespace HikSdk.ProvisioningCli;

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        var command = args.Length > 0 ? args[0].Trim().ToLowerInvariant() : "discover";
        var namedArgs = ParseNamedArgs(args.Skip(1).ToArray());

        try
        {
            return command switch
            {
                "discover" => await RunDiscoverAsync(namedArgs),
                "diagnostics" => await DiagnosticsReporter.RunAsync(),
                "provision" => await RunProvisionAsync(namedArgs),
                _ => throw new InvalidOperationException($"Bilinmeyen komut: {command}")
            };
        }
        catch (Exception exception)
        {
            await WriteJsonAsync(new
            {
                success = false,
                error = exception.Message
            });
            return 1;
        }
    }

    private static async Task<int> RunDiscoverAsync(IReadOnlyDictionary<string, string> args)
    {
        var subnetPrefix = args.GetValueOrDefault("subnetPrefix");
        var concurrency = int.TryParse(args.GetValueOrDefault("concurrency"), out var parsedConcurrency) ? Math.Max(1, parsedConcurrency) : 24;
        var scanSeconds = int.TryParse(args.GetValueOrDefault("scanSeconds"), out var parsedScanSeconds) ? Math.Max(3, parsedScanSeconds) : 20;
        using var scanner = new CancellationTokenSource(TimeSpan.FromSeconds(
            scanSeconds));

        var devices = await new NetworkScanner(concurrency).DiscoverAsync(subnetPrefix, scanner.Token);
        var timedOut = scanner.IsCancellationRequested;

        await WriteJsonAsync(new
        {
            success = true,
            method = "network-scan",
            stage = "discover",
            note = "Bu akis yerel IP taramasi yapar; resmi SADP / Layer-2 discovery degildir.",
            subnetPrefix,
            scanSeconds,
            timedOut,
            message = timedOut
                ? "Tarama suresi doldu. Kismi sonuc donuldu; daha genis tarama icin --scanSeconds degerini artirin."
                : "Tarama tamamlandi.",
            summary = new
            {
                totalCandidates = devices.Count,
                hikvisionCandidates = devices.Count(device => device.IsHikvision),
                pingOnlyCandidates = devices.Count(device =>
                    device.PingSucceeded &&
                    !device.Port80Open &&
                    !device.Port443Open &&
                    !device.Port554Open &&
                    !device.Port8000Open &&
                    !device.Port8080Open)
            },
            devices = devices.Select(device => new
            {
                device.IpAddress,
                device.MacAddress,
                device.SerialNumber,
                device.Model,
                device.ActivationStatus,
                device.IsHikvision,
                device.PingSucceeded,
                ports = new
                {
                    http80 = device.Port80Open,
                    https443 = device.Port443Open,
                    rtsp554 = device.Port554Open,
                    sdk8000 = device.Port8000Open,
                    http8080 = device.Port8080Open
                },
                device.SupportsSdkPort,
                device.SupportsIsapi
            })
        });

        return 0;
    }

    private static async Task<int> RunProvisionAsync(IReadOnlyDictionary<string, string> args)
    {
        var password = GetRequired(args, "password");
        var backendBaseUrl = GetRequired(args, "backendUrl");
        var sdkPort = ushort.TryParse(args.GetValueOrDefault("sdkPort"), out var parsedPort) ? parsedPort : (ushort)8000;
        var enableDhcp = bool.TryParse(args.GetValueOrDefault("enableDhcp"), out var parsedEnableDhcp) && parsedEnableDhcp;
        var gatewayOverride = args.GetValueOrDefault("gateway") ?? string.Empty;
        var primaryDns = args.GetValueOrDefault("dns1") ?? "8.8.8.8";
        var secondaryDns = args.GetValueOrDefault("dns2") ?? "1.1.1.1";
        var areaName = args.GetValueOrDefault("areaName") ?? string.Empty;
        var aliasOverride = args.GetValueOrDefault("alias") ?? string.Empty;
        var verificationCodeOverride = args.GetValueOrDefault("verificationCode") ?? string.Empty;
        var userName = string.IsNullOrWhiteSpace(args.GetValueOrDefault("userName")) ? "admin" : args.GetValueOrDefault("userName")!;
        var logDirectory = ResolveLogDirectory(args);

        var deviceSelection = await DiscoverAndSelectDeviceAsync(args, logDirectory);
        var currentIpAddress = deviceSelection.IpAddress;
        var activationPerformed = false;

        using (var sdkSession = new HikActivationSession())
        {
            sdkSession.Initialize(logDirectory);
            if (string.Equals(deviceSelection.ActivationStatus, "Inactive", StringComparison.OrdinalIgnoreCase))
            {
                var activationResult = sdkSession.ActivateDevice(currentIpAddress, sdkPort, password);
                if (!activationResult.Success)
                {
                    throw new InvalidOperationException($"NET_DVR_ActivateDevice basarisiz. NET_DVR_GetLastError={activationResult.ErrorCode}, Message={activationResult.ErrorMessage}");
                }

                activationPerformed = true;
            }
        }

        var options = new CameraConnectionOptions(currentIpAddress, userName, password);
        using var initialClient = new IsapiClient(options);

        DeviceInfoModel deviceInfo;
        try
        {
            deviceInfo = activationPerformed
                ? await initialClient.WaitForDeviceInfoAsync(TimeSpan.FromSeconds(90), TimeSpan.FromSeconds(3), CancellationToken.None)
                : await initialClient.GetDeviceInfoAsync(CancellationToken.None);
        }
        catch (IsapiRequestException exception) when (
            exception.StatusCode == HttpStatusCode.Forbidden &&
            string.Equals(exception.SubStatusCode, "notActivated", StringComparison.OrdinalIgnoreCase))
        {
            using var sdkSession = new HikActivationSession();
            sdkSession.Initialize(logDirectory);
            var activationResult = sdkSession.ActivateDevice(currentIpAddress, sdkPort, password);
            if (!activationResult.Success)
            {
                throw new InvalidOperationException($"NET_DVR_ActivateDevice basarisiz. NET_DVR_GetLastError={activationResult.ErrorCode}, Message={activationResult.ErrorMessage}");
            }

            activationPerformed = true;
            deviceInfo = await initialClient.WaitForDeviceInfoAsync(TimeSpan.FromSeconds(90), TimeSpan.FromSeconds(3), CancellationToken.None);
        }

        using (var sdkSession = new HikActivationSession())
        {
            sdkSession.Initialize(logDirectory);
            var loginResult = sdkSession.Login(currentIpAddress, sdkPort, userName, password);
            if (!loginResult.Success)
            {
                throw new InvalidOperationException($"NET_DVR_Login_V40 basarisiz. NET_DVR_GetLastError={loginResult.ErrorCode}, Message={loginResult.ErrorMessage}");
            }
        }

        var networkInterfaces = await initialClient.UpdateGatewayDnsAsync(
            gatewayOverride,
            dns1: primaryDns,
            dns2: secondaryDns,
            enableDhcp,
            CancellationToken.None);

        IsapiClient activeClient = initialClient;
        IsapiClient? updatedClient = null;

        if (enableDhcp)
        {
            var foundIp = await initialClient.FindCameraIpInSubnetAsync(
                currentIpAddress,
                userName,
                password,
                deviceInfo.ShortSerial,
                deviceInfo.MacAddress,
                CancellationToken.None);

            if (!string.IsNullOrWhiteSpace(foundIp))
            {
                currentIpAddress = foundIp;
                options = options with { CameraAddress = currentIpAddress };
                updatedClient = new IsapiClient(options);
                activeClient = updatedClient;
                networkInterfaces = await activeClient.GetNetworkInterfacesAsync(CancellationToken.None);
            }
        }

        var verificationCode = string.IsNullOrWhiteSpace(verificationCodeOverride)
            ? IsapiClient.CreateVerificationCode(12)
            : verificationCodeOverride.Trim();
        var ezvizResult = await activeClient.EnableEzvizAsync(
            verificationCode,
            pollInterval: TimeSpan.FromSeconds(5),
            timeout: TimeSpan.FromMinutes(2),
            cancellationToken: CancellationToken.None);

        if (ezvizResult.TimedOut)
        {
            throw new InvalidOperationException("registerStatus iki dakika icinde true olmadi. Gateway ve DNS baglantisini kontrol edin.");
        }

        var alias = string.IsNullOrWhiteSpace(aliasOverride) ? $"CAM-{deviceInfo.ShortSerial}" : aliasOverride.Trim();
        using var backendClient = new BackendProvisioningClient(backendBaseUrl);
        var backendResponse = await backendClient.RegisterProvisionedDeviceAsync(
            new BackendProvisioningRequest(
                deviceInfo.ShortSerial,
                verificationCode,
                alias,
                areaName,
                deviceInfo.Model,
                deviceInfo.SerialNumber,
                deviceInfo.SubSerialNumber,
                deviceInfo.FirmwareVersion,
                deviceInfo.MacAddress,
                currentIpAddress),
            CancellationToken.None);

        updatedClient?.Dispose();

        await WriteJsonAsync(new
        {
            success = true,
            discoveryNote = "Kamera secimi network-scan sonucu yapildi; bu akis resmi SADP / Layer-2 discovery degildir.",
            activationPerformed,
            device = new
            {
                deviceInfo.Model,
                deviceInfo.SerialNumber,
                deviceInfo.ShortSerial,
                deviceInfo.SubSerialNumber,
                deviceInfo.FirmwareVersion,
                deviceInfo.MacAddress,
                CurrentIpAddress = currentIpAddress
            },
            network = networkInterfaces,
            backend = backendResponse.Result
        });

        return 0;
    }

    private static async Task<SadpDeviceInfo> DiscoverAndSelectDeviceAsync(IReadOnlyDictionary<string, string> args, string logDirectory)
    {
        var explicitIp = args.GetValueOrDefault("ip");
        if (!string.IsNullOrWhiteSpace(explicitIp))
        {
            return new SadpDeviceInfo(
                Model: string.Empty,
                SerialNumber: string.Empty,
                MacAddress: string.Empty,
                IpAddress: explicitIp!,
                DhcpEnabled: false,
                ActivationStatus: "Unknown");
        }

        var subnetPrefix = args.GetValueOrDefault("subnetPrefix");
        var concurrency = int.TryParse(args.GetValueOrDefault("concurrency"), out var parsedConcurrency) ? Math.Max(1, parsedConcurrency) : 24;
        using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(
            int.TryParse(args.GetValueOrDefault("scanSeconds"), out var parsedScanSeconds) ? Math.Max(3, parsedScanSeconds) : 20));

        var devices = (await new NetworkScanner(concurrency).DiscoverAsync(subnetPrefix, timeoutCts.Token))
            .Where(device => device.IsHikvision || device.Port8000Open || device.Port80Open || device.Port443Open || device.Port8080Open)
            .ToList();

        var explicitMac = args.GetValueOrDefault("mac");
        var explicitSerial = args.GetValueOrDefault("serial");
        var matches = devices.Where(device =>
            (string.IsNullOrWhiteSpace(explicitMac) || string.Equals(device.MacAddress, explicitMac, StringComparison.OrdinalIgnoreCase)) &&
            (string.IsNullOrWhiteSpace(explicitSerial) || string.Equals(device.SerialNumber, explicitSerial, StringComparison.OrdinalIgnoreCase)))
            .ToList();

        if (matches.Count == 1)
        {
            return ToSadpInfo(matches[0]);
        }

        if (matches.Count == 0 && devices.Count == 1)
        {
            return ToSadpInfo(devices[0]);
        }

        if (matches.Count == 0)
        {
            throw new InvalidOperationException("Tarama tamamlandi ancak secim icin tekil kamera belirlenemedi. discover ciktisina bakip provision --ip <kamera-ip> ile gecici fallback kullanin.");
        }

        _ = logDirectory;
        throw new InvalidOperationException("Birden fazla kamera bulundu. discover ciktisina bakip provision --ip <kamera-ip> ile gecici fallback kullanin veya --mac/--serial ile filtreleyin.");
    }

    private static Dictionary<string, string> ParseNamedArgs(string[] args)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < args.Length; i++)
        {
            var current = args[i];
            if (!current.StartsWith("--", StringComparison.Ordinal))
            {
                continue;
            }

            var key = current[2..];
            var value = i + 1 < args.Length ? args[i + 1] : string.Empty;
            result[key] = value;
            i++;
        }

        return result;
    }

    private static string GetRequired(IReadOnlyDictionary<string, string> args, string key)
    {
        if (args.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value))
        {
            return value;
        }

        throw new InvalidOperationException($"Eksik parametre: --{key}");
    }

    private static string ResolveLogDirectory(IReadOnlyDictionary<string, string> args)
    {
        var provided = args.GetValueOrDefault("logDir");
        return string.IsNullOrWhiteSpace(provided)
            ? Path.Combine(AppContext.BaseDirectory, "sdk-logs")
            : provided!;
    }

    private static async Task WriteJsonAsync(object payload)
    {
        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(payload, new JsonSerializerOptions
        {
            WriteIndented = true
        }));
    }

    private static SadpDeviceInfo ToSadpInfo(DiscoveredCameraInfo camera)
    {
        return new SadpDeviceInfo(
            Model: camera.Model,
            SerialNumber: camera.SerialNumber,
            MacAddress: camera.MacAddress,
            IpAddress: camera.IpAddress,
            DhcpEnabled: false,
            ActivationStatus: camera.ActivationStatus);
    }
}
