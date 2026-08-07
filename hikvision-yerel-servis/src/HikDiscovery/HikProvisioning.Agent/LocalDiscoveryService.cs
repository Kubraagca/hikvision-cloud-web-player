using HikSdk.Interop;

internal sealed class LocalDiscoveryService
{
    public async Task<LocalDiscoveryResult> DiscoverAsync(string? subnetPrefix, int concurrency, int scanSeconds, bool fullScan, CancellationToken cancellationToken)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(Math.Max(3, scanSeconds)));

        try
        {
            var result = await Task.Run(GetSadpCandidates, timeoutCts.Token).ConfigureAwait(false);
            return new LocalDiscoveryResult(result.Devices, false, result.ErrorMessage);
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            return new LocalDiscoveryResult(Array.Empty<LocalDiscoveredDevice>(), true, "HCNetSDK tarama zaman asimina ugradi.");
        }
    }

    private static SadpDiscoveryAttemptResult GetSadpCandidates()
    {
        try
        {
            using var sdk = new HikSdkSession();
            sdk.Initialize();

            var poll = sdk.PollSadpDevices();
            if (!poll.Success)
            {
                var error = poll.Error;
                var sdkErrorMessage = error is null
                    ? "NET_DVR_GetSadpInfoList basarisiz oldu."
                    : $"NET_DVR_GetSadpInfoList basarisiz. Error={error.ErrorCode}, Symbol={error.ErrorSymbol}, Message={error.ErrorMessage}";
                return new SadpDiscoveryAttemptResult(Array.Empty<LocalDiscoveredDevice>(), sdkErrorMessage);
            }

            var devices = poll.Devices
                .Where(device => !string.IsNullOrWhiteSpace(device.IpAddress))
                .GroupBy(device => BuildDiscoveryKey(device), StringComparer.OrdinalIgnoreCase)
                .Select(group => group.First())
                .OrderBy(device => ParseLastOctet(device.IpAddress))
                .ThenBy(device => device.IpAddress, StringComparer.OrdinalIgnoreCase)
                .Select(device => new LocalDiscoveredDevice(
                    IpAddress: device.IpAddress,
                    MacAddress: FirstNonEmpty(device.MacAddress, "-"),
                    SerialNumber: FirstNonEmpty(device.SerialNumber, "-"),
                    Model: FirstNonEmpty(device.Model, "-"),
                    ActivationStatus: FirstNonEmpty(device.ActivationStatus, "Unknown"),
                    SdkPort: device.SdkPort,
                    Gateway: FirstNonEmpty(device.Gateway, "-"),
                    SubnetMask: FirstNonEmpty(device.SubnetMask, "-"),
                    IsHikvision: true,
                    SupportsIsapi: true,
                    SupportsSdkPort: device.SdkPort > 0))
                .ToArray();

            var discoveryMessage = devices.Length == 0
                ? "HCNetSDK taramasi tamamlandi fakat cihaz listesi bos dondu."
                : string.Empty;

            return new SadpDiscoveryAttemptResult(devices, discoveryMessage);
        }
        catch (Exception exception)
        {
            return new SadpDiscoveryAttemptResult(Array.Empty<LocalDiscoveredDevice>(), exception.Message);
        }
    }

    private static string BuildDiscoveryKey(SadpDeviceInfo device)
    {
        var serial = FirstNonEmpty(device.SerialNumber);
        if (!string.IsNullOrWhiteSpace(serial))
        {
            return $"SERIAL:{serial}";
        }

        var mac = FirstNonEmpty(device.MacAddress);
        if (!string.IsNullOrWhiteSpace(mac))
        {
            return $"MAC:{mac}";
        }

        return $"IP:{device.IpAddress}";
    }

    private static string FirstNonEmpty(params string[] values) =>
        values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? string.Empty;

    private static int ParseLastOctet(string ipAddress)
    {
        var lastSegment = ipAddress.Split('.').LastOrDefault();
        return int.TryParse(lastSegment, out var value) ? value : int.MaxValue;
    }
}

internal sealed record LocalDiscoveryResult(IReadOnlyList<LocalDiscoveredDevice> Devices, bool TimedOut, string ErrorMessage);

internal sealed record SadpDiscoveryAttemptResult(IReadOnlyList<LocalDiscoveredDevice> Devices, string ErrorMessage);

internal sealed record LocalDiscoveredDevice(
    string IpAddress,
    string MacAddress,
    string SerialNumber,
    string Model,
    string ActivationStatus,
    ushort SdkPort,
    string Gateway,
    string SubnetMask,
    bool IsHikvision,
    bool SupportsIsapi,
    bool SupportsSdkPort);
