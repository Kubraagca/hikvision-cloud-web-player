using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Xml.Linq;

namespace HikSdk.SadpWpf;

internal sealed class LocalNetworkCameraDiscoveryService
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

    public LocalNetworkCameraDiscoveryService(int concurrency = 64, TimeSpan? requestTimeout = null)
    {
        _concurrency = Math.Max(8, concurrency);
        _requestTimeout = requestTimeout ?? TimeSpan.FromMilliseconds(450);
    }

    public async Task<IReadOnlyList<DiscoveredCameraModel>> DiscoverAsync(CancellationToken cancellationToken)
    {
        var priorityHits = await ProbePriorityAddressesAsync(cancellationToken).ConfigureAwait(false);
        var candidates = GetCandidateSubnets();

        if (candidates.Count == 0)
        {
            return priorityHits;
        }

        var results = new List<DiscoveredCameraModel>(priorityHits);
        foreach (var candidate in candidates)
        {
            results.AddRange(await ScanSubnetAsync(candidate, cancellationToken).ConfigureAwait(false));
        }

        return results
            .GroupBy(item => item.IpAddress, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .OrderBy(item => ParseLastOctet(item.IpAddress))
            .ToArray();
    }

    private async Task<IReadOnlyList<DiscoveredCameraModel>> ProbePriorityAddressesAsync(CancellationToken cancellationToken)
    {
        var results = new List<DiscoveredCameraModel>();
        foreach (var ipAddress in GetPriorityAddresses())
        {
            var match = await ProbeHostAsync(ipAddress, cancellationToken).ConfigureAwait(false);
            if (match is not null)
            {
                results.Add(match);
            }
        }

        return results;
    }

    private async Task<IReadOnlyList<DiscoveredCameraModel>> ScanSubnetAsync(SubnetCandidate candidate, CancellationToken cancellationToken)
    {
        using var semaphore = new SemaphoreSlim(_concurrency);
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
            return results.Where(item => item is not null).Cast<DiscoveredCameraModel>().ToArray();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return tasks
                .Where(task => task.IsCompletedSuccessfully && task.Result is not null)
                .Select(task => task.Result!)
                .ToArray();
        }
    }

    private async Task<DiscoveredCameraModel?> ProbeHostAsync(string ipAddress, CancellationToken cancellationToken)
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

        return new DiscoveredCameraModel(
            IpAddress: ipAddress,
            MacAddress: FirstNonEmpty(deviceInfoProbe.MacAddress, macAddress, "-"),
            SerialNumber: FirstNonEmpty(deviceInfoProbe.SerialNumber, "-"),
            Model: FirstNonEmpty(deviceInfoProbe.Model, "-"),
            ActivationStatus: FirstNonEmpty(activationStatus, "Unknown"),
            IsHikvision: isHikvision,
            SupportsIsapi: activationProbe.IsHikvision || deviceInfoProbe.IsHikvision || port80Open,
            SupportsSdkPort: port8000Open,
            PingSucceeded: pingSucceeded);
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
            .SelectMany(adapter => adapter.GetIPProperties().UnicastAddresses)
            .Where(address =>
                address.Address.AddressFamily == AddressFamily.InterNetwork &&
                !IPAddress.IsLoopback(address.Address))
            .Where(address => IsPrivateIpv4(address.Address.ToString()))
            .Select(CreateCandidate)
            .Where(candidate => candidate is not null)
            .Cast<SubnetCandidate>()
            .GroupBy(candidate => $"{candidate.StartAddress}-{candidate.HostCount}", StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .ToList();
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
