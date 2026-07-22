using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;

namespace HikSdk.SadpWpf;

public sealed class IsapiRequestException : InvalidOperationException
{
    public IsapiRequestException(string message, HttpStatusCode statusCode, string responseBody, string subStatusCode)
        : base(message)
    {
        StatusCode = statusCode;
        ResponseBody = responseBody;
        SubStatusCode = subStatusCode;
    }

    public HttpStatusCode StatusCode { get; }

    public string ResponseBody { get; }

    public string SubStatusCode { get; }
}

public sealed class IsapiClient : IDisposable
{
    private readonly HttpClient _httpClient;

    public IsapiClient(CameraConnectionOptions options)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(options.CameraAddress);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.UserName);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.Password);

        var baseUri = BuildBaseUri(options.CameraAddress);
        var handler = new HttpClientHandler
        {
            PreAuthenticate = false,
            Credentials = new NetworkCredential(options.UserName, options.Password)
        };

        _httpClient = new HttpClient(handler, disposeHandler: true)
        {
            BaseAddress = baseUri,
            Timeout = TimeSpan.FromSeconds(20)
        };
        _httpClient.DefaultRequestHeaders.Accept.Clear();
        _httpClient.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/xml"));
    }

    public async Task<DeviceInfoModel> GetDeviceInfoAsync(CancellationToken cancellationToken)
    {
        var document = await GetXmlAsync("/ISAPI/System/deviceInfo", cancellationToken).ConfigureAwait(false);
        var root = document.Root;
        var serialNumber = GetValue(root, "serialNumber");
        var subSerialNumber = GetValue(root, "subSerialNumber");
        var shortSerial = string.IsNullOrWhiteSpace(subSerialNumber) ? serialNumber : subSerialNumber;

        return new DeviceInfoModel(
            GetValue(root, "model"),
            serialNumber,
            shortSerial,
            subSerialNumber,
            GetValue(root, "firmwareVersion"),
            NormalizeMac(GetValue(root, "macAddress")));
    }

    public async Task<ActivateStatusResult> GetActivateStatusAsync(CancellationToken cancellationToken)
    {
        var document = await GetXmlAsync("/ISAPI/System/activateStatus", cancellationToken).ConfigureAwait(false);
        var status = GetValue(document.Root, "activateStatus");
        var subStatusCode = GetValue(document.Root, "subStatusCode");
        var normalized = status.Trim().ToLowerInvariant();

        return new ActivateStatusResult(
            IsActive: normalized is "active" or "activated" or "1" or "true",
            IsInactive: normalized is "inactive" or "notactivated" or "not_activated" or "0" or "false",
            SubStatusCode: subStatusCode);
    }

    public async Task<DeviceInfoModel> WaitForDeviceInfoAsync(
        TimeSpan timeout,
        TimeSpan retryInterval,
        CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        Exception? lastException = null;

        do
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                return await GetDeviceInfoAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception)
            {
                lastException = exception;
            }

            await Task.Delay(retryInterval, cancellationToken).ConfigureAwait(false);
        }
        while (DateTimeOffset.UtcNow < deadline);

        throw new InvalidOperationException(
            "Aktivasyon sonrasi 90 saniye boyunca /ISAPI/System/deviceInfo okunamadi.",
            lastException);
    }

    public async Task<IReadOnlyList<NetworkInterfaceModel>> GetNetworkInterfacesAsync(CancellationToken cancellationToken)
    {
        var document = await GetXmlAsync("/ISAPI/System/Network/interfaces", cancellationToken).ConfigureAwait(false);
        return ParseNetworkInterfaces(document);
    }

    public async Task<IReadOnlyList<NetworkInterfaceModel>> UpdateGatewayDnsAsync(
        string? gatewayOverride,
        string dns1,
        string dns2,
        bool enableDhcp,
        CancellationToken cancellationToken)
    {
        var document = await GetXmlAsync("/ISAPI/System/Network/interfaces", cancellationToken).ConfigureAwait(false);
        var interfaces = ParseNetworkInterfaces(document);

        foreach (var model in interfaces)
        {
            var interfaceElement = FindInterfaceElement(document, model.Id, model.IpAddress);
            if (interfaceElement is null)
            {
                continue;
            }

            var effectiveGateway = string.IsNullOrWhiteSpace(gatewayOverride)
                ? InferGateway(gatewayOverride, model.IpAddress, model.Gateway)
                : gatewayOverride.Trim();

            SetValue(interfaceElement, "DefaultGateway", effectiveGateway);
            SetValue(interfaceElement, "defaultGateway", effectiveGateway);
            SetValue(interfaceElement, "ipv4DefaultGateway", effectiveGateway);
            SetValue(interfaceElement, "PrimaryDNS", dns1);
            SetValue(interfaceElement, "primaryDNS", dns1);
            SetValue(interfaceElement, "dnsServer1IpAddr", dns1);
            SetValue(interfaceElement, "SecondaryDNS", dns2);
            SetValue(interfaceElement, "secondaryDNS", dns2);
            SetValue(interfaceElement, "dnsServer2IpAddr", dns2);

            if (enableDhcp)
            {
                SetValue(interfaceElement, "ipAddressingType", "dynamic");
                SetValue(interfaceElement, "addressingType", "dynamic");
                SetValue(interfaceElement, "DHCP", "true");
                SetValue(interfaceElement, "dhcp", "true");
            }
        }

        await PutXmlAsync("/ISAPI/System/Network/interfaces", document.ToString(SaveOptions.DisableFormatting), cancellationToken).ConfigureAwait(false);
        return await GetNetworkInterfacesAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<string?> FindCameraIpInSubnetAsync(
        string originalIpAddress,
        string userName,
        string password,
        string expectedShortSerial,
        string expectedMacAddress,
        CancellationToken cancellationToken)
    {
        var prefix = GetSubnetPrefix(originalIpAddress);
        if (prefix is null)
        {
            return null;
        }

        using var semaphore = new SemaphoreSlim(16);
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var tasks = Enumerable.Range(1, 254).Select(async host =>
        {
            var candidateIp = $"{prefix}.{host}";
            await semaphore.WaitAsync(linkedCts.Token).ConfigureAwait(false);
            try
            {
                using var candidateClient = new IsapiClient(new CameraConnectionOptions(candidateIp, userName, password));
                var info = await candidateClient.GetDeviceInfoAsync(linkedCts.Token).ConfigureAwait(false);
                if (string.Equals(info.ShortSerial, expectedShortSerial, StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(NormalizeMac(info.MacAddress), NormalizeMac(expectedMacAddress), StringComparison.OrdinalIgnoreCase))
                {
                    linkedCts.Cancel();
                    return candidateIp;
                }
            }
            catch
            {
                // Probe failures are expected during limited subnet scan.
            }
            finally
            {
                semaphore.Release();
            }

            return null;
        }).ToArray();

        try
        {
            var results = await Task.WhenAll(tasks).ConfigureAwait(false);
            return results.FirstOrDefault(result => !string.IsNullOrWhiteSpace(result));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            var results = tasks
                .Where(task => task.IsCompletedSuccessfully)
                .Select(task => task.Result)
                .FirstOrDefault(result => !string.IsNullOrWhiteSpace(result));
            return results;
        }
    }

    public async Task<EzvizStatusModel> GetEzvizStatusAsync(CancellationToken cancellationToken)
    {
        var document = await GetXmlAsync("/ISAPI/System/Network/EZVIZ", cancellationToken).ConfigureAwait(false);
        return ParseEzvizStatus(document);
    }

    public async Task<EnableEzvizResult> EnableEzvizAsync(
        string verificationCode,
        TimeSpan pollInterval,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(verificationCode);

        var requestXml = $"""
<?xml version="1.0" encoding="UTF-8"?>
<EZVIZ version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <enabled>true</enabled>
  <verificationCode>{SecurityElement.Escape(verificationCode)}</verificationCode>
</EZVIZ>
""";

        await PutXmlAsync("/ISAPI/System/Network/EZVIZ", requestXml, cancellationToken).ConfigureAwait(false);

        var deadline = DateTimeOffset.UtcNow + timeout;
        var pollCount = 0;
        EzvizStatusModel latestStatus;

        do
        {
            cancellationToken.ThrowIfCancellationRequested();
            pollCount++;
            latestStatus = await GetEzvizStatusAsync(cancellationToken).ConfigureAwait(false);
            if (latestStatus.RegisterStatus == true)
            {
                return new EnableEzvizResult(latestStatus, pollCount, TimedOut: false);
            }

            await Task.Delay(pollInterval, cancellationToken).ConfigureAwait(false);
        }
        while (DateTimeOffset.UtcNow < deadline);

        latestStatus = await GetEzvizStatusAsync(cancellationToken).ConfigureAwait(false);
        return new EnableEzvizResult(latestStatus, pollCount, TimedOut: latestStatus.RegisterStatus != true);
    }

    public static string CreateVerificationCode(int length = 12)
    {
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        var bytes = RandomNumberGenerator.GetBytes(length);
        var builder = new StringBuilder(length);
        foreach (var value in bytes)
        {
            builder.Append(alphabet[value % alphabet.Length]);
        }

        return builder.ToString();
    }

    public void Dispose()
    {
        _httpClient.Dispose();
    }

    private async Task<XDocument> GetXmlAsync(string requestUri, CancellationToken cancellationToken)
    {
        using var response = await _httpClient.GetAsync(requestUri, cancellationToken).ConfigureAwait(false);
        var xml = await ReadXmlOrThrowAsync(response, cancellationToken).ConfigureAwait(false);
        return XDocument.Parse(xml);
    }

    private async Task PutXmlAsync(string requestUri, string xml, CancellationToken cancellationToken)
    {
        using var content = new StringContent(xml, Encoding.UTF8, "application/xml");
        using var response = await _httpClient.PutAsync(requestUri, content, cancellationToken).ConfigureAwait(false);
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        throw CreateRequestException("PUT", requestUri, response.StatusCode, body);
    }

    private static async Task<string> ReadXmlOrThrowAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        var xml = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (response.IsSuccessStatusCode)
        {
            return xml;
        }

        throw CreateRequestException(response.RequestMessage?.Method.Method ?? "GET", response.RequestMessage?.RequestUri?.ToString() ?? string.Empty, response.StatusCode, xml);
    }

    private static Exception CreateRequestException(string method, string requestUri, HttpStatusCode statusCode, string body)
    {
        var shortBody = string.IsNullOrWhiteSpace(body)
            ? "Bos yanit."
            : string.Join(" ", body.Split(default(string[]), StringSplitOptions.RemoveEmptyEntries)).Trim();
        if (shortBody.Length > 240)
        {
            shortBody = shortBody[..240] + "...";
        }

        var subStatusCode = TryExtractSubStatusCode(body);
        return new IsapiRequestException(
            $"{method} {requestUri} basarisiz. HTTP {(int)statusCode} ({statusCode}). Yanit: {shortBody}",
            statusCode,
            body,
            subStatusCode);
    }

    private static IReadOnlyList<NetworkInterfaceModel> ParseNetworkInterfaces(XDocument document)
    {
        var roots = document.Descendants().Where(element =>
            element.Name.LocalName.Equals("NetworkInterface", StringComparison.OrdinalIgnoreCase) ||
            element.Name.LocalName.Equals("Interface", StringComparison.OrdinalIgnoreCase)).ToArray();

        if (roots.Length == 0 && document.Root is not null)
        {
            roots = [document.Root];
        }

        return roots
            .Select(ParseNetworkInterface)
            .Where(model => !string.IsNullOrWhiteSpace(model.IpAddress) || !string.IsNullOrWhiteSpace(model.Id))
            .ToArray();
    }

    private static NetworkInterfaceModel ParseNetworkInterface(XElement element)
    {
        var id = FirstNonEmpty(element, "id", "interfaceId", "name", "portNo");
        var ipAddress = FirstNonEmpty(element, "ipAddress", "ipv4Address", "IPAddress");
        var subnetMask = FirstNonEmpty(element, "subnetMask", "ipv4SubnetMask");
        var gateway = FirstNonEmpty(element, "DefaultGateway", "defaultGateway", "ipv4DefaultGateway");
        var primaryDns = FirstNonEmpty(element, "PrimaryDNS", "primaryDNS", "dnsServer1IpAddr", "DNS1");
        var secondaryDns = FirstNonEmpty(element, "SecondaryDNS", "secondaryDNS", "dnsServer2IpAddr", "DNS2");
        var dhcpMode = FirstNonEmpty(element, "addressingType", "ipAddressingType", "dhcp", "DHCP");

        return new NetworkInterfaceModel(
            EmptyToDash(id),
            EmptyToDash(ipAddress),
            EmptyToDash(subnetMask),
            EmptyToDash(gateway),
            EmptyToDash(primaryDns),
            EmptyToDash(secondaryDns),
            EmptyToDash(dhcpMode),
            element.ToString(SaveOptions.DisableFormatting));
    }

    private static XElement? FindInterfaceElement(XDocument document, string interfaceId, string ipAddress)
    {
        return document
            .Descendants()
            .FirstOrDefault(element =>
                element.Name.LocalName is "NetworkInterface" or "Interface" &&
                (string.Equals(FirstNonEmpty(element, "id", "interfaceId", "name", "portNo"), interfaceId, StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(FirstNonEmpty(element, "ipAddress", "ipv4Address", "IPAddress"), ipAddress, StringComparison.OrdinalIgnoreCase)));
    }

    private static string GetValue(XElement? root, string localName)
    {
        if (root is null)
        {
            return string.Empty;
        }

        var namespaceMatch = root.DescendantsAndSelf().FirstOrDefault(item => item.Name == root.GetDefaultNamespace() + localName);
        if (namespaceMatch is not null)
        {
            return namespaceMatch.Value.Trim();
        }

        var localNameMatch = root.DescendantsAndSelf().FirstOrDefault(item =>
            item.Name.LocalName.Equals(localName, StringComparison.OrdinalIgnoreCase));
        return localNameMatch?.Value.Trim() ?? string.Empty;
    }

    private static void SetValue(XElement root, string localName, string value)
    {
        foreach (var element in root.DescendantsAndSelf().Where(item => item.Name.LocalName.Equals(localName, StringComparison.OrdinalIgnoreCase)))
        {
            element.Value = value;
        }
    }

    private static string TryExtractSubStatusCode(string xml)
    {
        if (string.IsNullOrWhiteSpace(xml))
        {
            return string.Empty;
        }

        try
        {
            var document = XDocument.Parse(xml);
            return GetValue(document.Root, "subStatusCode");
        }
        catch
        {
            return string.Empty;
        }
    }

    private static EzvizStatusModel ParseEzvizStatus(XDocument document)
    {
        var root = document.Root;
        var enabledValue = GetValue(root, "enabled");
        var registerStatusValue = GetValue(root, "registerStatus");
        var verificationCode = GetValue(root, "verificationCode");

        return new EzvizStatusModel(
            TryParseBoolean(enabledValue),
            TryParseBoolean(registerStatusValue),
            !string.IsNullOrWhiteSpace(verificationCode));
    }

    private static Uri BuildBaseUri(string cameraAddress)
    {
        var trimmed = cameraAddress.Trim();
        if (!trimmed.Contains("://", StringComparison.Ordinal))
        {
            trimmed = "http://" + trimmed;
        }

        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri))
        {
            throw new InvalidOperationException("Kamera adresi gecersiz. Ornek: 192.168.1.64 veya http://192.168.1.64");
        }

        return uri;
    }

    private static string FirstNonEmpty(XElement root, params string[] localNames)
    {
        foreach (var localName in localNames)
        {
            var value = GetValue(root, localName);
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value;
            }
        }

        return string.Empty;
    }

    private static bool? TryParseBoolean(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        return value.Trim().ToLowerInvariant() switch
        {
            "true" => true,
            "false" => false,
            "1" => true,
            "0" => false,
            _ => null
        };
    }

    private static string EmptyToDash(string value) =>
        string.IsNullOrWhiteSpace(value) ? "-" : value.Trim();

    private static string NormalizeMac(string mac)
    {
        return mac.Replace(":", "-", StringComparison.Ordinal).Trim().ToUpperInvariant();
    }

    private static string InferGateway(string? gatewayOverride, string ipAddress, string currentGateway)
    {
        if (!string.IsNullOrWhiteSpace(gatewayOverride))
        {
            return gatewayOverride.Trim();
        }

        if (!string.IsNullOrWhiteSpace(currentGateway) && currentGateway != "-")
        {
            return currentGateway;
        }

        var prefix = GetSubnetPrefix(ipAddress);
        return prefix is null ? currentGateway : $"{prefix}.1";
    }

    private static string? GetSubnetPrefix(string ipAddress)
    {
        var parts = ipAddress.Split('.', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return parts.Length == 4 ? $"{parts[0]}.{parts[1]}.{parts[2]}" : null;
    }
}
