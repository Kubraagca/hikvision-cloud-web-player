using System.Net;
using System.Net.Http.Headers;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Xml.Linq;

namespace HikSdk.ProvisioningCli;

internal sealed class NetworkScanner
{
    private const int MaxHostsPerSubnet = 1022;
    private readonly int _concurrency;
    private readonly TimeSpan _requestTimeout;

    public NetworkScanner(int concurrency = 24, TimeSpan? requestTimeout = null)
    {
        _concurrency = Math.Max(1, concurrency);
        _requestTimeout = requestTimeout ?? TimeSpan.FromSeconds(2);
    }

    public async Task<IReadOnlyList<DiscoveredCameraInfo>> DiscoverAsync(string? subnetPrefix, CancellationToken cancellationToken)
    {
        var candidates = string.IsNullOrWhiteSpace(subnetPrefix)
            ? GetCandidateSubnets()
            : [CreateManualCandidate(subnetPrefix.Trim())];

        if (candidates.Count == 0)
        {
            throw new InvalidOperationException("Tarama icin uygun bir yerel IPv4 agi bulunamadi. --subnetPrefix 192.168.1 gibi bir deger verin.");
        }

        var results = new List<DiscoveredCameraInfo>();
        foreach (var candidate in candidates)
        {
            var subnetResults = await ScanSubnetAsync(candidate, cancellationToken).ConfigureAwait(false);
            results.AddRange(subnetResults);
        }

        return results
            .GroupBy(device => device.IpAddress, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .OrderBy(device => ParseLastOctet(device.IpAddress))
            .ToArray();
    }

    private async Task<IReadOnlyList<DiscoveredCameraInfo>> ScanSubnetAsync(SubnetCandidate subnet, CancellationToken cancellationToken)
    {
        using var semaphore = new SemaphoreSlim(_concurrency);
        var tasks = Enumerable.Range(0, subnet.HostCount).Select(async offset =>
        {
            await semaphore.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                return await ProbeHostAsync(FromUInt32(subnet.StartAddress + (uint)offset), cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                semaphore.Release();
            }
        }).ToArray();

        try
        {
            var results = await Task.WhenAll(tasks).ConfigureAwait(false);
            return results.Where(result => result is not null).Cast<DiscoveredCameraInfo>().ToArray();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return tasks
                .Where(task => task.IsCompletedSuccessfully && task.Result is not null)
                .Select(task => task.Result!)
                .ToArray();
        }
    }

    private async Task<DiscoveredCameraInfo?> ProbeHostAsync(string ipAddress, CancellationToken cancellationToken)
    {
        var pingSucceeded = await PingHostAsync(ipAddress, cancellationToken).ConfigureAwait(false);
        var port80Open = await CanConnectTcpAsync(ipAddress, 80, cancellationToken).ConfigureAwait(false);
        var port443Open = await CanConnectTcpAsync(ipAddress, 443, cancellationToken).ConfigureAwait(false);
        var port554Open = await CanConnectTcpAsync(ipAddress, 554, cancellationToken).ConfigureAwait(false);
        var port8000Open = await CanConnectTcpAsync(ipAddress, 8000, cancellationToken).ConfigureAwait(false);
        var port8080Open = await CanConnectTcpAsync(ipAddress, 8080, cancellationToken).ConfigureAwait(false);

        if (!pingSucceeded && !port80Open && !port443Open && !port554Open && !port8000Open && !port8080Open)
        {
            return null;
        }

        var scheme = port80Open ? "http" : "https";
        var baseUri = $"{scheme}://{ipAddress}";
        var macAddress = TryResolveMac(ipAddress);

        (bool IsHikvision, string ActivationStatus) activateProbe = (false, string.Empty);
        (bool IsHikvision, bool Authenticated, string Model, string SerialNumber, string MacAddress) deviceInfoProbe =
            (false, false, string.Empty, string.Empty, string.Empty);

        if (port80Open || port443Open || port8080Open)
        {
            activateProbe = await ProbeActivateStatusAsync(baseUri, cancellationToken).ConfigureAwait(false);
            deviceInfoProbe = await ProbeDeviceInfoAsync(baseUri, cancellationToken).ConfigureAwait(false);
        }

        var isHikvision = activateProbe.IsHikvision || deviceInfoProbe.IsHikvision;
        var activationStatus = activateProbe.ActivationStatus;
        if (string.IsNullOrWhiteSpace(activationStatus))
        {
            activationStatus = deviceInfoProbe.Authenticated ? "Active" : pingSucceeded ? "Unverified" : "Unknown";
        }

        return new DiscoveredCameraInfo(
            IpAddress: ipAddress,
            MacAddress: FirstNonEmpty(deviceInfoProbe.MacAddress, macAddress, "-"),
            SerialNumber: FirstNonEmpty(deviceInfoProbe.SerialNumber, "-"),
            Model: FirstNonEmpty(deviceInfoProbe.Model, "-"),
            ActivationStatus: FirstNonEmpty(activationStatus, "Unknown"),
            IsHikvision: isHikvision,
            SupportsIsapi: activateProbe.IsHikvision || deviceInfoProbe.IsHikvision,
            SupportsSdkPort: port8000Open,
            PingSucceeded: pingSucceeded,
            Port80Open: port80Open,
            Port443Open: port443Open,
            Port554Open: port554Open,
            Port8000Open: port8000Open,
            Port8080Open: port8080Open);
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
                var status = ParseActivationStatus(body);
                return (true, status);
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
        var ipString = address.Address.ToString();
        var parts = ipString.Split('.', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
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

        var hostCount = (int)Math.Min(lastHostValue - firstHostValue + 1, MaxHostsPerSubnet);
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
                GetValue(document.Root, "activated"),
                GetValue(document.Root, "activeStatus"),
                GetValue(document.Root, "status"));

            return value.Trim().ToLowerInvariant() switch
            {
                "true" => "Active",
                "active" => "Active",
                "1" => "Active",
                "false" => "Inactive",
                "inactive" => "Inactive",
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
