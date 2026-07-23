using System.Net;
using System.Net.Http.Headers;
using System.Security;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;

internal sealed record AgentCameraConnectionOptions(string CameraAddress, string UserName, string Password);

internal sealed record AgentDeviceInfoInfo(
    string Model,
    string SerialNumber,
    string ShortSerial,
    string SubSerialNumber,
    string FirmwareVersion,
    string MacAddress);

internal sealed record AgentActivateStatusInfo(bool IsActive, bool IsInactive, string SubStatusCode);

internal sealed record AgentNetworkInterfaceInfo(
    string Id,
    string IpAddress,
    string SubnetMask,
    string Gateway,
    string PrimaryDns,
    string SecondaryDns,
    string DhcpMode,
    string RawXml);

internal sealed record AgentEzvizStatusInfo(bool? Enabled, bool? RegisterStatus, bool HasVerificationCode);
internal sealed record AgentEnableEzvizInfo(AgentEzvizStatusInfo FinalStatus, int PollCount, bool TimedOut);

internal sealed class AgentCameraIsapiException : InvalidOperationException
{
    public AgentCameraIsapiException(string message, HttpStatusCode statusCode, string responseBody, string subStatusCode)
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

internal sealed class AgentCameraIsapiClient : IDisposable
{
    private readonly HttpClient _httpClient;

    public AgentCameraIsapiClient(AgentCameraConnectionOptions options)
    {
        var handler = new HttpClientHandler
        {
            PreAuthenticate = false,
            Credentials = new NetworkCredential(options.UserName, options.Password)
        };

        _httpClient = new HttpClient(handler, disposeHandler: true)
        {
            BaseAddress = BuildBaseUri(options.CameraAddress),
            Timeout = TimeSpan.FromSeconds(20)
        };
        _httpClient.DefaultRequestHeaders.Accept.Clear();
        _httpClient.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/xml"));
    }

    public async Task<AgentDeviceInfoInfo> GetDeviceInfoAsync(CancellationToken cancellationToken)
    {
        var document = await GetXmlAsync("/ISAPI/System/deviceInfo", cancellationToken).ConfigureAwait(false);
        var serialNumber = GetValue(document.Root, "serialNumber");
        var subSerialNumber = GetValue(document.Root, "subSerialNumber");
        var shortSerial = string.IsNullOrWhiteSpace(subSerialNumber) ? serialNumber : subSerialNumber;

        return new AgentDeviceInfoInfo(
            GetValue(document.Root, "model"),
            serialNumber,
            shortSerial,
            subSerialNumber,
            GetValue(document.Root, "firmwareVersion"),
            NormalizeMac(GetValue(document.Root, "macAddress")));
    }

    public async Task<AgentActivateStatusInfo> GetActivateStatusAsync(CancellationToken cancellationToken)
    {
        var document = await GetXmlAsync("/ISAPI/System/activateStatus", cancellationToken).ConfigureAwait(false);
        var status = GetValue(document.Root, "activateStatus");
        var subStatusCode = GetValue(document.Root, "subStatusCode");
        var normalized = status.Trim().ToLowerInvariant();

        return new AgentActivateStatusInfo(
            normalized is "active" or "activated" or "1" or "true",
            normalized is "inactive" or "notactivated" or "not_activated" or "0" or "false",
            subStatusCode);
    }

    public async Task<AgentDeviceInfoInfo> WaitForDeviceInfoAsync(TimeSpan timeout, TimeSpan retryInterval, CancellationToken cancellationToken)
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
        } while (DateTimeOffset.UtcNow < deadline);

        throw new InvalidOperationException("Aktivasyon sonrasi /ISAPI/System/deviceInfo okunamadi.", lastException);
    }

    public async Task<IReadOnlyList<AgentNetworkInterfaceInfo>> GetNetworkInterfacesAsync(CancellationToken cancellationToken)
    {
        var document = await GetXmlAsync("/ISAPI/System/Network/interfaces", cancellationToken).ConfigureAwait(false);
        return ParseNetworkInterfaces(document);
    }

    public async Task<AgentEzvizStatusInfo> GetEzvizStatusAsync(CancellationToken cancellationToken)
    {
        var document = await GetXmlAsync("/ISAPI/System/Network/EZVIZ", cancellationToken).ConfigureAwait(false);
        return ParseEzvizStatus(document);
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

        return new AgentCameraIsapiException(
            $"{method} {requestUri} basarisiz. HTTP {(int)statusCode} ({statusCode}). Yanit: {shortBody}",
            statusCode,
            body,
            TryExtractSubStatusCode(body));
    }

    private static IReadOnlyList<AgentNetworkInterfaceInfo> ParseNetworkInterfaces(XDocument document)
    {
        var roots = document.Descendants().Where(element =>
            element.Name.LocalName.Equals("NetworkInterface", StringComparison.OrdinalIgnoreCase) ||
            element.Name.LocalName.Equals("Interface", StringComparison.OrdinalIgnoreCase)).ToArray();

        if (roots.Length == 0 && document.Root is not null)
        {
            roots = [document.Root];
        }

        return roots.Select(ParseNetworkInterface)
            .Where(model => !string.IsNullOrWhiteSpace(model.IpAddress) || !string.IsNullOrWhiteSpace(model.Id))
            .ToArray();
    }

    private static AgentNetworkInterfaceInfo ParseNetworkInterface(XElement element)
    {
        var id = FirstNonEmpty(element, "id", "interfaceId", "name", "portNo");
        var ipAddress = FirstNonEmpty(element, "ipAddress", "ipv4Address", "IPAddress");
        var subnetMask = FirstNonEmpty(element, "subnetMask", "ipv4SubnetMask");
        var gateway = ReadNetworkAddress(element, "DefaultGateway", "defaultGateway", "ipv4DefaultGateway");
        var primaryDns = ReadNetworkAddress(element, "PrimaryDNS", "primaryDNS", "dnsServer1IpAddr", "DNS1");
        var secondaryDns = ReadNetworkAddress(element, "SecondaryDNS", "secondaryDNS", "dnsServer2IpAddr", "DNS2");
        var dhcpMode = FirstNonEmpty(element, "addressingType", "ipAddressingType", "dhcp", "DHCP");

        return new AgentNetworkInterfaceInfo(
            EmptyToDash(id),
            EmptyToDash(ipAddress),
            EmptyToDash(subnetMask),
            EmptyToDash(gateway),
            EmptyToDash(primaryDns),
            EmptyToDash(secondaryDns),
            EmptyToDash(dhcpMode),
            element.ToString(SaveOptions.DisableFormatting));
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

        var localNameMatch = root.DescendantsAndSelf().FirstOrDefault(item => item.Name.LocalName.Equals(localName, StringComparison.OrdinalIgnoreCase));
        return localNameMatch?.Value.Trim() ?? string.Empty;
    }

    private static string ReadNetworkAddress(XElement root, params string[] localNames)
    {
        foreach (var localName in localNames)
        {
            foreach (var element in root.DescendantsAndSelf().Where(item => item.Name.LocalName.Equals(localName, StringComparison.OrdinalIgnoreCase)))
            {
                var nestedValue = FirstNonEmpty(element, "ipAddress", "ipv4Address", "address");
                if (!string.IsNullOrWhiteSpace(nestedValue))
                {
                    return nestedValue;
                }

                var value = element.Value.Trim();
                if (!string.IsNullOrWhiteSpace(value))
                {
                    return value;
                }
            }
        }

        return string.Empty;
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

    private static AgentEzvizStatusInfo ParseEzvizStatus(XDocument document)
    {
        var enabledValue = GetValue(document.Root, "enabled");
        var registerStatusValue = GetValue(document.Root, "registerStatus");
        var verificationCode = GetValue(document.Root, "verificationCode");

        return new AgentEzvizStatusInfo(
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

        return Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)
            ? uri
            : throw new InvalidOperationException("Kamera adresi gecersiz.");
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

    private static string NormalizeMac(string mac) =>
        mac.Replace(":", "-", StringComparison.Ordinal).Trim().ToUpperInvariant();
}
