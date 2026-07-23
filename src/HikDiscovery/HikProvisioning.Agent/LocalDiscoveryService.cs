using System.Net;
using System.Net.Http.Headers;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Xml.Linq;

internal sealed class LocalDiscoveryService
{
    private readonly int _concurrency;
    private readonly TimeSpan _requestTimeout;
    private const int MaxFullSubnetHosts = 160;
    private static readonly string[] DefaultPriorityIps =
    [
        "192.168.1.64",
        "192.168.0.64",
        "192.168.1.65",
        "192.168.0.65",
        "192.168.1.1",
        "192.168.0.1"
    ];

    public LocalDiscoveryService(int concurrency = 64, TimeSpan? requestTimeout = null)
    {
        _concurrency = Math.Max(8, concurrency);
        _requestTimeout = requestTimeout ?? TimeSpan.FromMilliseconds(450);
    }

    public async Task<LocalDiscoveryResult> DiscoverAsync(string? subnetPrefix, int concurrency, int scanSeconds, CancellationToken cancellationToken)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(Math.Max(3, scanSeconds)));

        var results = new List<LocalDiscoveredDevice>();

        try
        {
            results.AddRange(await ProbePriorityAddressesAsync(timeoutCts.Token).ConfigureAwait(false));

            var candidates = string.IsNullOrWhiteSpace(subnetPrefix)
                ? GetCandidateSubnets()
                : [CreateManualCandidate(subnetPrefix.Trim())];

            foreach (var candidate in candidates)
            {
                if (timeoutCts.IsCancellationRequested)
                {
                    break;
                }

                results.AddRange(await ScanSubnetAsync(candidate, Math.Max(8, concurrency), timeoutCts.Token).ConfigureAwait(false));
            }
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested)
        {
        }

        var devices = results
            .GroupBy(item => item.IpAddress, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .OrderBy(item => ParseLastOctet(item.IpAddress))
            .ToArray();

        return new LocalDiscoveryResult(devices, timeoutCts.IsCancellationRequested && !cancellationToken.IsCancellationRequested);
    }

    private async Task<IReadOnlyList<LocalDiscoveredDevice>> ProbePriorityAddressesAsync(CancellationToken cancellationToken)
    {
        var results = new List<LocalDiscoveredDevice>();
        foreach (var ipAddress in GetPriorityAddresses())
        {
            if (cancellationToken.IsCancellationRequested)
            {
                break;
            }

            var match = await ProbeHostAsync(ipAddress, cancellationToken).ConfigureAwait(false);
            if (match is not null)
            {
                results.Add(match);
            }
        }

        return results;
    }

    private async Task<IReadOnlyList<LocalDiscoveredDevice>> ScanSubnetAsync(SubnetCandidate candidate, int concurrency, CancellationToken cancellationToken)
    {
        using var semaphore = new SemaphoreSlim(concurrency);
        var tasks = EnumerateCandidateOffsets(candidate.HostCount).Select(async offset =>
        {
            await semaphore.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                return await ProbeHostAsync(FromUInt32(candidate.StartAddress + (uint)offset), cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                semaphore.Release();
            }
        }).ToArray();

        try
        {
            var results = await Task.WhenAll(tasks).ConfigureAwait(false);
            return results.Where(item => item is not null).Cast<LocalDiscoveredDevice>().ToArray();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return tasks
                .Where(task => task.IsCompletedSuccessfully && task.Result is not null)
                .Select(task => task.Result!)
                .ToArray();
        }
    }

    private async Task<LocalDiscoveredDevice?> ProbeHostAsync(string ipAddress, CancellationToken cancellationToken)
    {
        var pingTask = PingHostAsync(ipAddress, cancellationToken);
        var port80Task = CanConnectTcpAsync(ipAddress, 80, cancellationToken);
        var port554Task = CanConnectTcpAsync(ipAddress, 554, cancellationToken);
        var port8000Task = CanConnectTcpAsync(ipAddress, 8000, cancellationToken);

        await Task.WhenAll(pingTask, port80Task, port554Task, port8000Task).ConfigureAwait(false);

        var pingSucceeded = pingTask.Result;
        var port80Open = port80Task.Result;
        var port554Open = port554Task.Result;
        var port8000Open = port8000Task.Result;

        if (!pingSucceeded && !port80Open && !port554Open && !port8000Open)
        {
            return null;
        }

        var baseUri = $"http://{ipAddress}";
        var macAddress = TryResolveMac(ipAddress);
        var activationProbe = (IsHikvision: false, ActivationStatus: string.Empty);
        var deviceInfoProbe = (IsHikvision: false, Authenticated: false, Model: string.Empty, SerialNumber: string.Empty, MacAddress: string.Empty);

        if (port80Open)
        {
            var activateTask = ProbeActivateStatusAsync(baseUri, cancellationToken);
            var deviceInfoTask = ProbeDeviceInfoAsync(baseUri, cancellationToken);
            await Task.WhenAll(activateTask, deviceInfoTask).ConfigureAwait(false);
            activationProbe = activateTask.Result;
            deviceInfoProbe = deviceInfoTask.Result;
        }

        var isHikvision = activationProbe.IsHikvision || deviceInfoProbe.IsHikvision || port8000Open;
        var looksLikeCamera = isHikvision || port554Open || ipAddress.EndsWith(".64", StringComparison.Ordinal);
        if (!looksLikeCamera)
        {
            return null;
        }

        var activationStatus = activationProbe.ActivationStatus;
        if (string.IsNullOrWhiteSpace(activationStatus))
        {
            activationStatus = deviceInfoProbe.Authenticated ? "Active" : "Unknown";
        }

        return new LocalDiscoveredDevice(
            IpAddress: ipAddress,
            MacAddress: FirstNonEmpty(deviceInfoProbe.MacAddress, macAddress, "-"),
            SerialNumber: FirstNonEmpty(deviceInfoProbe.SerialNumber, "-"),
            Model: FirstNonEmpty(deviceInfoProbe.Model, "-"),
            ActivationStatus: FirstNonEmpty(activationStatus, "Unknown"),
            IsHikvision: isHikvision,
            SupportsIsapi: activationProbe.IsHikvision || deviceInfoProbe.IsHikvision || port80Open,
            SupportsSdkPort: port8000Open);
    }

    private async Task<bool> PingHostAsync(string ipAddress, CancellationToken cancellationToken)
    {
        using var ping = new Ping();
        try
        {
            var reply = await ping.SendPingAsync(ipAddress, (int)_requestTimeout.TotalMilliseconds).WaitAsync(cancellationToken).ConfigureAwait(false);
            return reply.Status == IPStatus.Success;
        }
        catch
        {
            return false;
        }
    }

    private async Task<bool> CanConnectTcpAsync(string ipAddress, int port, CancellationToken cancellationToken)
    {
        using var client = new TcpClient();
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(_requestTimeout);
        try
        {
            await client.ConnectAsync(IPAddress.Parse(ipAddress), port, timeoutCts.Token).ConfigureAwait(false);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private async Task<(bool IsHikvision, string ActivationStatus)> ProbeActivateStatusAsync(string baseUri, CancellationToken cancellationToken)
    {
        using var client = CreateProbeHttpClient(baseUri);
        try
        {
            using var response = await client.GetAsync("/ISAPI/System/activateStatus", cancellationToken).ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

            if (response.IsSuccessStatusCode)
            {
                return (true, ParseActivationStatus(body));
            }

            var subStatusCode = TryExtractSubStatusCode(body);
            if (response.StatusCode == HttpStatusCode.Forbidden &&
                string.Equals(subStatusCode, "notActivated", StringComparison.OrdinalIgnoreCase))
            {
                return (true, "Inactive");
            }

            if (response.StatusCode == HttpStatusCode.Unauthorized && LooksLikeDigestChallenge(response))
            {
                return (true, "Active");
            }

            return (LooksLikeHikvisionResponse(response, body), string.Empty);
        }
        catch
        {
            return (false, string.Empty);
        }
    }

    private async Task<(bool IsHikvision, bool Authenticated, string Model, string SerialNumber, string MacAddress)> ProbeDeviceInfoAsync(string baseUri, CancellationToken cancellationToken)
    {
        using var client = CreateProbeHttpClient(baseUri);
        try
        {
            using var response = await client.GetAsync("/ISAPI/System/deviceInfo", cancellationToken).ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

            if (response.IsSuccessStatusCode)
            {
                var document = XDocument.Parse(body);
                return (
                    true,
                    true,
                    GetValue(document.Root, "model"),
                    GetValue(document.Root, "serialNumber"),
                    NormalizeMac(GetValue(document.Root, "macAddress")));
            }

            if (response.StatusCode == HttpStatusCode.Unauthorized && LooksLikeDigestChallenge(response))
            {
                return (true, false, string.Empty, string.Empty, string.Empty);
            }

            var subStatusCode = TryExtractSubStatusCode(body);
            if (response.StatusCode == HttpStatusCode.Forbidden &&
                string.Equals(subStatusCode, "notActivated", StringComparison.OrdinalIgnoreCase))
            {
                return (true, false, string.Empty, string.Empty, string.Empty);
            }

            return (LooksLikeHikvisionResponse(response, body), false, string.Empty, string.Empty, string.Empty);
        }
        catch
        {
            return (false, false, string.Empty, string.Empty, string.Empty);
        }
    }

    private HttpClient CreateProbeHttpClient(string baseUri)
    {
        var handler = new HttpClientHandler
        {
            PreAuthenticate = false,
            AllowAutoRedirect = false
        };

        var client = new HttpClient(handler, disposeHandler: true)
        {
            BaseAddress = new Uri(baseUri),
            Timeout = _requestTimeout
        };
        client.DefaultRequestHeaders.Accept.Clear();
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/xml"));
        return client;
    }

    private static List<SubnetCandidate> GetCandidateSubnets()
    {
        return NetworkInterface.GetAllNetworkInterfaces()
            .Where(adapter =>
                adapter.OperationalStatus == OperationalStatus.Up &&
                adapter.NetworkInterfaceType is NetworkInterfaceType.Wireless80211 or NetworkInterfaceType.Ethernet)
            .Where(adapter => !IsLikelyVirtualAdapter(adapter))
            .SelectMany(adapter => adapter.GetIPProperties().UnicastAddresses.Select(address => new
            {
                Address = address,
                AdapterName = adapter.Name,
                AdapterDescription = adapter.Description
            }))
            .Where(item =>
                item.Address.Address.AddressFamily == AddressFamily.InterNetwork &&
                !IPAddress.IsLoopback(item.Address.Address))
            .Where(item => IsPrivateIpv4(item.Address.Address.ToString()))
            .Select(item => new
            {
                Candidate = CreateCandidate(item.Address),
                IpAddress = item.Address.Address.ToString(),
                item.AdapterName,
                item.AdapterDescription
            })
            .Where(item => item.Candidate is not null)
            .OrderBy(item => GetSubnetPriority(item.IpAddress))
            .ThenBy(item => item.IpAddress, StringComparer.OrdinalIgnoreCase)
            .Select(item => item.Candidate)
            .Where(candidate => candidate is not null)
            .Cast<SubnetCandidate>()
            .GroupBy(candidate => $"{candidate.StartAddress}-{candidate.HostCount}", StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .ToList();
    }

    private static SubnetCandidate CreateManualCandidate(string subnetPrefix)
    {
        var parts = subnetPrefix.Split('.', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length != 3 ||
            !byte.TryParse(parts[0], out _) ||
            !byte.TryParse(parts[1], out _) ||
            !byte.TryParse(parts[2], out _))
        {
            throw new InvalidOperationException("--subnetPrefix degeri 192.168.1 formatinda olmalidir.");
        }

        return new SubnetCandidate(ToUInt32FromString($"{subnetPrefix}.1"), 254);
    }

    private static SubnetCandidate? CreateCandidate(UnicastIPAddressInformation address)
    {
        var parts = address.Address.ToString().Split('.', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length != 4 ||
            !byte.TryParse(parts[0], out var a) ||
            !byte.TryParse(parts[1], out var b) ||
            !byte.TryParse(parts[2], out var c) ||
            !byte.TryParse(parts[3], out var d))
        {
            return null;
        }

        var prefixLength = address.PrefixLength is > 0 and <= 32 ? address.PrefixLength : 24;
        var ipValue = ToUInt32(a, b, c, d);
        var mask = prefixLength == 0 ? 0u : uint.MaxValue << (32 - prefixLength);
        var network = ipValue & mask;
        var broadcast = network | ~mask;
        var firstHostValue = network + 1;
        var lastHostValue = broadcast - 1;

        if (lastHostValue <= firstHostValue)
        {
            return null;
        }

        var hostCount = (int)Math.Min(lastHostValue - firstHostValue + 1, MaxFullSubnetHosts);
        return new SubnetCandidate(firstHostValue, hostCount);
    }

    private static bool IsPrivateIpv4(string ipAddress)
    {
        var parts = ipAddress.Split('.', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length != 4 ||
            !byte.TryParse(parts[0], out var a) ||
            !byte.TryParse(parts[1], out var b))
        {
            return false;
        }

        return a == 10 ||
               (a == 172 && b is >= 16 and <= 31) ||
               (a == 192 && b == 168);
    }

    private static bool IsLikelyVirtualAdapter(NetworkInterface adapter)
    {
        var text = $"{adapter.Name} {adapter.Description}";
        return text.Contains("Hyper-V", StringComparison.OrdinalIgnoreCase) ||
               text.Contains("vEthernet", StringComparison.OrdinalIgnoreCase) ||
               text.Contains("WSL", StringComparison.OrdinalIgnoreCase) ||
               text.Contains("Virtual", StringComparison.OrdinalIgnoreCase) ||
               text.Contains("VMware", StringComparison.OrdinalIgnoreCase) ||
               text.Contains("VirtualBox", StringComparison.OrdinalIgnoreCase) ||
               text.Contains("Docker", StringComparison.OrdinalIgnoreCase) ||
               text.Contains("TAP-", StringComparison.OrdinalIgnoreCase) ||
               text.Contains("Tailscale", StringComparison.OrdinalIgnoreCase) ||
               text.Contains("ZeroTier", StringComparison.OrdinalIgnoreCase);
    }

    private static int GetSubnetPriority(string ipAddress)
    {
        var parts = ipAddress.Split('.', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length != 4 ||
            !byte.TryParse(parts[0], out var a) ||
            !byte.TryParse(parts[1], out var b))
        {
            return int.MaxValue;
        }

        if (a == 192 && b == 168)
        {
            return 0;
        }

        if (a == 10)
        {
            return 1;
        }

        if (a == 172 && b is >= 16 and <= 31)
        {
            return 2;
        }

        return 3;
    }

    private static bool LooksLikeDigestChallenge(HttpResponseMessage response)
    {
        return response.Headers.WwwAuthenticate.Any(header =>
            header.Scheme.Contains("Digest", StringComparison.OrdinalIgnoreCase));
    }

    private static bool LooksLikeHikvisionResponse(HttpResponseMessage response, string body)
    {
        if (LooksLikeDigestChallenge(response))
        {
            return true;
        }

        var joinedHeaders = string.Join(" ", response.Headers.Select(header => $"{header.Key}:{string.Join(",", header.Value)}"));
        return joinedHeaders.Contains("Hikvision", StringComparison.OrdinalIgnoreCase) ||
               body.Contains("/ISAPI/", StringComparison.OrdinalIgnoreCase) ||
               body.Contains("notActivated", StringComparison.OrdinalIgnoreCase);
    }

    private static string ParseActivationStatus(string xml)
    {
        if (string.IsNullOrWhiteSpace(xml))
        {
            return string.Empty;
        }

        try
        {
            var document = XDocument.Parse(xml);
            var value = FirstNonEmpty(
                GetValue(document.Root, "activateStatus"),
                GetValue(document.Root, "activated"),
                GetValue(document.Root, "activeStatus"),
                GetValue(document.Root, "status"));

            return value.Trim().ToLowerInvariant() switch
            {
                "true" => "Active",
                "active" => "Active",
                "activated" => "Active",
                "1" => "Active",
                "false" => "Inactive",
                "inactive" => "Inactive",
                "notactivated" => "Inactive",
                "0" => "Inactive",
                _ => string.Empty
            };
        }
        catch
        {
            return string.Empty;
        }
    }

    private static string GetValue(XElement? root, string localName)
    {
        if (root is null)
        {
            return string.Empty;
        }

        var match = root.DescendantsAndSelf().FirstOrDefault(item =>
            item.Name.LocalName.Equals(localName, StringComparison.OrdinalIgnoreCase));
        return match?.Value.Trim() ?? string.Empty;
    }

    private static string TryExtractSubStatusCode(string xml)
    {
        if (string.IsNullOrWhiteSpace(xml))
        {
            return string.Empty;
        }

        try
        {
            return GetValue(XDocument.Parse(xml).Root, "subStatusCode");
        }
        catch
        {
            return string.Empty;
        }
    }

    private static string NormalizeMac(string mac) =>
        string.IsNullOrWhiteSpace(mac)
            ? string.Empty
            : mac.Replace(":", "-", StringComparison.Ordinal).Trim().ToUpperInvariant();

    private static string FirstNonEmpty(params string[] values) =>
        values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value)) ?? string.Empty;

    private static int ParseLastOctet(string ipAddress)
    {
        var lastSegment = ipAddress.Split('.').LastOrDefault();
        return int.TryParse(lastSegment, out var value) ? value : int.MaxValue;
    }

    private static IEnumerable<int> EnumerateCandidateOffsets(int hostCount)
    {
        var emitted = new HashSet<int>();
        foreach (var preferredHost in GetPreferredHosts())
        {
            var offset = preferredHost - 1;
            if (offset >= 0 && offset < hostCount && emitted.Add(offset))
            {
                yield return offset;
            }
        }

        for (var offset = 0; offset < hostCount; offset++)
        {
            if (emitted.Add(offset))
            {
                yield return offset;
            }
        }
    }

    private static IEnumerable<int> GetPreferredHosts()
    {
        yield return 64;
        yield return 65;
        yield return 63;
        yield return 1;
        yield return 2;
        yield return 3;
        yield return 10;
        yield return 100;
        yield return 101;
        yield return 102;
    }

    private static IEnumerable<string> GetPriorityAddresses()
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var ip in DefaultPriorityIps)
        {
            if (seen.Add(ip))
            {
                yield return ip;
            }
        }

        foreach (var candidate in GetCandidateSubnets())
        {
            var firstHost = FromUInt32(candidate.StartAddress);
            var parts = firstHost.Split('.');
            if (parts.Length != 4)
            {
                continue;
            }

            var prioritized = $"{parts[0]}.{parts[1]}.{parts[2]}.64";
            if (seen.Add(prioritized))
            {
                yield return prioritized;
            }
        }
    }

    private static uint ToUInt32(byte a, byte b, byte c, byte d) =>
        ((uint)a << 24) | ((uint)b << 16) | ((uint)c << 8) | d;

    private static uint ToUInt32FromString(string ipAddress)
    {
        var parts = ipAddress.Split('.', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length != 4 ||
            !byte.TryParse(parts[0], out var a) ||
            !byte.TryParse(parts[1], out var b) ||
            !byte.TryParse(parts[2], out var c) ||
            !byte.TryParse(parts[3], out var d))
        {
            throw new InvalidOperationException("Gecersiz IPv4 adresi.");
        }

        return ToUInt32(a, b, c, d);
    }

    private static string FromUInt32(uint value)
    {
        var a = (value >> 24) & 0xFF;
        var b = (value >> 16) & 0xFF;
        var c = (value >> 8) & 0xFF;
        var d = value & 0xFF;
        return $"{a}.{b}.{c}.{d}";
    }

    private static string TryResolveMac(string ipAddress)
    {
        try
        {
            var addressBytes = IPAddress.Parse(ipAddress).GetAddressBytes();
            var destination = BitConverter.ToInt32(addressBytes, 0);
            var macBuffer = new byte[6];
            var length = macBuffer.Length;
            var result = SendARP(destination, 0, macBuffer, ref length);
            if (result != 0 || length <= 0)
            {
                return string.Empty;
            }

            return string.Join("-", macBuffer.Take(length).Select(value => value.ToString("X2")));
        }
        catch
        {
            return string.Empty;
        }
    }

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern int SendARP(int destIp, int srcIp, byte[] macAddr, ref int physicalAddrLen);

    private sealed record SubnetCandidate(uint StartAddress, int HostCount);
}

internal sealed record LocalDiscoveryResult(IReadOnlyList<LocalDiscoveredDevice> Devices, bool TimedOut);

internal sealed record LocalDiscoveredDevice(
    string IpAddress,
    string MacAddress,
    string SerialNumber,
    string Model,
    string ActivationStatus,
    bool IsHikvision,
    bool SupportsIsapi,
    bool SupportsSdkPort);
