using System.Net;
using System.Net.Http.Headers;
using System.Security;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;
using HikSdk.Interop;

namespace HikProvisioning.Web.Services;

public sealed class CameraProvisioningService
{
    private readonly HikConnectGatewayService _gatewayService;
    private readonly ProvisioningTaskStore _taskStore;
    private readonly ILogger<CameraProvisioningService> _logger;

    public CameraProvisioningService(
        HikConnectGatewayService gatewayService,
        ProvisioningTaskStore taskStore,
        ILogger<CameraProvisioningService> logger)
    {
        _gatewayService = gatewayService;
        _taskStore = taskStore;
        _logger = logger;
    }

    public ProvisioningTaskState StartProvisioning(ProvisioningRequest request, CancellationToken cancellationToken)
    {
        var state = _taskStore.Create(request);
        _ = Task.Run(() => RunProvisioningAsync(state, cancellationToken), CancellationToken.None);
        return state;
    }

    private async Task RunProvisioningAsync(ProvisioningTaskState task, CancellationToken cancellationToken)
    {
        try
        {
            var options = new CameraConnectionOptions(
                task.Input.CameraAddress.Trim(),
                string.IsNullOrWhiteSpace(task.Input.UserName) ? "admin" : task.Input.UserName.Trim(),
                task.Input.Password);

            string currentIpAddress = options.CameraAddress;
            task.SetStage("Erisim", "Calisiyor", "Kamera erisimi ve aktivasyon durumu kontrol ediliyor.");

            var activationRequired = false;
            using var initialClient = new CameraIsapiClient(options);
            try
            {
                var activateStatus = await initialClient.GetActivateStatusAsync(cancellationToken).ConfigureAwait(false);
                activationRequired = activateStatus.IsInactive;
            }
            catch (CameraIsapiException exception) when (
                exception.StatusCode == HttpStatusCode.Forbidden &&
                string.Equals(exception.SubStatusCode, "notActivated", StringComparison.OrdinalIgnoreCase))
            {
                activationRequired = true;
            }

            task.SetStage("Erisim", "Tamam", activationRequired ? "Kamera inactive bulundu." : "Kamera aktif.");

            if (activationRequired)
            {
                task.SetStage("Aktivasyon", "Calisiyor", "HCNetSDK ile kamera aktive ediliyor.");
                using var session = new HikActivationSession();
                session.Initialize(Path.Combine(AppContext.BaseDirectory, "sdk-logs"));
                var activationResult = session.ActivateDevice(currentIpAddress, task.Input.SdkPort, options.Password);
                if (!activationResult.Success)
                {
                    throw new InvalidOperationException($"NET_DVR_ActivateDevice basarisiz. NET_DVR_GetLastError={activationResult.ErrorCode}, Message={activationResult.ErrorMessage}");
                }

                task.SetStage("Aktivasyon", "Tamam", "Kamera aktive edildi.");
            }
            else
            {
                task.SetStage("Aktivasyon", "Atlandi", "Kamera zaten aktif.");
            }

            task.SetStage("Giris", "Calisiyor", "deviceInfo okunuyor ve HCNetSDK login dogrulaniyor.");
            var deviceInfo = activationRequired
                ? await initialClient.WaitForDeviceInfoAsync(TimeSpan.FromSeconds(90), TimeSpan.FromSeconds(3), cancellationToken).ConfigureAwait(false)
                : await initialClient.GetDeviceInfoAsync(cancellationToken).ConfigureAwait(false);

            using (var session = new HikActivationSession())
            {
                session.Initialize(Path.Combine(AppContext.BaseDirectory, "sdk-logs"));
                var loginResult = session.Login(currentIpAddress, task.Input.SdkPort, options.UserName, options.Password);
                if (!loginResult.Success)
                {
                    throw new InvalidOperationException($"NET_DVR_Login_V40 basarisiz. NET_DVR_GetLastError={loginResult.ErrorCode}, Message={loginResult.ErrorMessage}");
                }
            }

            task.SetStage("Giris", "Tamam", $"Model={deviceInfo.Model}, KisaSeri={deviceInfo.ShortSerial}");

            task.SetStage("Ag Ayari", "Calisiyor", "Ag bilgileri okunuyor ve gateway/DNS guncelleniyor.");
            var networkInterfaces = await initialClient.GetNetworkInterfacesAsync(cancellationToken).ConfigureAwait(false);
            var updatedInterfaces = await initialClient.UpdateGatewayDnsAsync(
                task.Input.GatewayOverride,
                "8.8.8.8",
                "1.1.1.1",
                task.Input.EnableDhcp,
                cancellationToken).ConfigureAwait(false);

            if (task.Input.EnableDhcp)
            {
                var foundIp = await initialClient.FindCameraIpInSubnetAsync(
                    currentIpAddress,
                    options.UserName,
                    options.Password,
                    deviceInfo.ShortSerial,
                    deviceInfo.MacAddress,
                    cancellationToken).ConfigureAwait(false);

                if (!string.IsNullOrWhiteSpace(foundIp))
                {
                    currentIpAddress = foundIp;
                    options = options with { CameraAddress = currentIpAddress };
                    using var updatedClient = new CameraIsapiClient(options);
                    updatedInterfaces = await updatedClient.GetNetworkInterfacesAsync(cancellationToken).ConfigureAwait(false);
                }
            }

            task.SetStage("Ag Ayari", "Tamam", $"Guncel IP={currentIpAddress}");

            task.SetStage("Hik-Connect Online", "Calisiyor", "EZVIZ/Hik-Connect etkinlestiriliyor.");
            var verificationCode = CameraIsapiClient.CreateVerificationCode(12);
            using var activeClient = new CameraIsapiClient(options);
            var ezvizResult = await activeClient.EnableEzvizAsync(
                verificationCode,
                TimeSpan.FromSeconds(5),
                TimeSpan.FromMinutes(2),
                cancellationToken).ConfigureAwait(false);

            if (ezvizResult.TimedOut)
            {
                throw new InvalidOperationException("registerStatus iki dakika icinde true olmadi. Gateway ve DNS baglantisini kontrol edin.");
            }

            task.SetStage("Hik-Connect Online", "Tamam", "registerStatus=true oldu.");

            task.SetStage("Team Hesabina Ekleme", "Calisiyor", "Cihaz Team hesabina ekleniyor.");
            var alias = $"CAM-{deviceInfo.ShortSerial}";
            var backendResult = await _gatewayService.AddDeviceAsync(
                new TeamDeviceAddRequest(deviceInfo.ShortSerial, verificationCode, alias, task.Input.AreaName),
                cancellationToken).ConfigureAwait(false);

            if (!backendResult.Success)
            {
                throw new InvalidOperationException(backendResult.Message);
            }

            task.SetStage("Team Hesabina Ekleme", "Tamam", backendResult.DeviceStatusMessage);
            task.SetStage("Kanal Aktarimi", "Tamam", backendResult.ChannelStatusMessage);
            task.SetStage("Tamamlandi", "Tamam", "Kurulum tamamlandi.");

            task.Complete(new ProvisioningResult(
                backendResult.DeviceId,
                backendResult.AreaId,
                backendResult.AreaName,
                alias,
                deviceInfo.Model,
                deviceInfo.SerialNumber,
                deviceInfo.ShortSerial,
                deviceInfo.SubSerialNumber,
                deviceInfo.FirmwareVersion,
                deviceInfo.MacAddress,
                currentIpAddress,
                updatedInterfaces));
        }
        catch (Exception exception)
        {
            _logger.LogError(exception, "Provisioning task failed for {CameraAddress}", task.Input.CameraAddress);
            task.Fail(SanitizeError(exception.Message, task.Input.Password));
        }
    }

    private static string SanitizeError(string message, string password)
    {
        var sanitized = message;
        if (!string.IsNullOrWhiteSpace(password))
        {
            sanitized = sanitized.Replace(password, "***", StringComparison.Ordinal);
        }

        return sanitized;
    }
}

public sealed record CameraConnectionOptions(string CameraAddress, string UserName, string Password);

public sealed record DeviceInfoInfo(
    string Model,
    string SerialNumber,
    string ShortSerial,
    string SubSerialNumber,
    string FirmwareVersion,
    string MacAddress);

public sealed record ActivateStatusInfo(bool IsActive, bool IsInactive, string SubStatusCode);

public sealed record NetworkInterfaceInfo(
    string Id,
    string IpAddress,
    string SubnetMask,
    string Gateway,
    string PrimaryDns,
    string SecondaryDns,
    string DhcpMode,
    string RawXml);

public sealed record EzvizStatusInfo(bool? Enabled, bool? RegisterStatus, bool HasVerificationCode);
public sealed record EnableEzvizInfo(EzvizStatusInfo FinalStatus, int PollCount, bool TimedOut);

public sealed class CameraIsapiException : InvalidOperationException
{
    public CameraIsapiException(string message, HttpStatusCode statusCode, string responseBody, string subStatusCode)
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

public sealed class CameraIsapiClient : IDisposable
{
    private readonly HttpClient _httpClient;

    public CameraIsapiClient(CameraConnectionOptions options)
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

    public async Task<DeviceInfoInfo> GetDeviceInfoAsync(CancellationToken cancellationToken)
    {
        var document = await GetXmlAsync("/ISAPI/System/deviceInfo", cancellationToken).ConfigureAwait(false);
        var serialNumber = GetValue(document.Root, "serialNumber");
        var subSerialNumber = GetValue(document.Root, "subSerialNumber");
        var shortSerial = string.IsNullOrWhiteSpace(subSerialNumber) ? serialNumber : subSerialNumber;

        return new DeviceInfoInfo(
            GetValue(document.Root, "model"),
            serialNumber,
            shortSerial,
            subSerialNumber,
            GetValue(document.Root, "firmwareVersion"),
            NormalizeMac(GetValue(document.Root, "macAddress")));
    }

    public async Task<ActivateStatusInfo> GetActivateStatusAsync(CancellationToken cancellationToken)
    {
        var document = await GetXmlAsync("/ISAPI/System/activateStatus", cancellationToken).ConfigureAwait(false);
        var status = GetValue(document.Root, "activateStatus");
        var subStatusCode = GetValue(document.Root, "subStatusCode");
        var normalized = status.Trim().ToLowerInvariant();

        return new ActivateStatusInfo(
            normalized is "active" or "activated" or "1" or "true",
            normalized is "inactive" or "notactivated" or "not_activated" or "0" or "false",
            subStatusCode);
    }

    public async Task<DeviceInfoInfo> WaitForDeviceInfoAsync(TimeSpan timeout, TimeSpan retryInterval, CancellationToken cancellationToken)
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

    public async Task<IReadOnlyList<NetworkInterfaceInfo>> GetNetworkInterfacesAsync(CancellationToken cancellationToken)
    {
        var document = await GetXmlAsync("/ISAPI/System/Network/interfaces", cancellationToken).ConfigureAwait(false);
        return ParseNetworkInterfaces(document);
    }

    public async Task<IReadOnlyList<NetworkInterfaceInfo>> UpdateGatewayDnsAsync(
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

    public async Task<string?> FindCameraIpInSubnetAsync(string originalIpAddress, string userName, string password, string expectedShortSerial, string expectedMacAddress, CancellationToken cancellationToken)
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
                using var candidateClient = new CameraIsapiClient(new CameraConnectionOptions(candidateIp, userName, password));
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

    public async Task<EzvizStatusInfo> GetEzvizStatusAsync(CancellationToken cancellationToken)
    {
        var document = await GetXmlAsync("/ISAPI/System/Network/EZVIZ", cancellationToken).ConfigureAwait(false);
        return ParseEzvizStatus(document);
    }

    public async Task<EnableEzvizInfo> EnableEzvizAsync(string verificationCode, TimeSpan pollInterval, TimeSpan timeout, CancellationToken cancellationToken)
    {
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
        EzvizStatusInfo latestStatus;

        do
        {
            cancellationToken.ThrowIfCancellationRequested();
            pollCount++;
            latestStatus = await GetEzvizStatusAsync(cancellationToken).ConfigureAwait(false);
            if (latestStatus.RegisterStatus == true)
            {
                return new EnableEzvizInfo(latestStatus, pollCount, false);
            }

            await Task.Delay(pollInterval, cancellationToken).ConfigureAwait(false);
        } while (DateTimeOffset.UtcNow < deadline);

        latestStatus = await GetEzvizStatusAsync(cancellationToken).ConfigureAwait(false);
        return new EnableEzvizInfo(latestStatus, pollCount, latestStatus.RegisterStatus != true);
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
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            throw CreateRequestException("PUT", requestUri, response.StatusCode, body);
        }
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

        return new CameraIsapiException(
            $"{method} {requestUri} basarisiz. HTTP {(int)statusCode} ({statusCode}). Yanit: {shortBody}",
            statusCode,
            body,
            TryExtractSubStatusCode(body));
    }

    private static IReadOnlyList<NetworkInterfaceInfo> ParseNetworkInterfaces(XDocument document)
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

    private static NetworkInterfaceInfo ParseNetworkInterface(XElement element)
    {
        var id = FirstNonEmpty(element, "id", "interfaceId", "name", "portNo");
        var ipAddress = FirstNonEmpty(element, "ipAddress", "ipv4Address", "IPAddress");
        var subnetMask = FirstNonEmpty(element, "subnetMask", "ipv4SubnetMask");
        var gateway = FirstNonEmpty(element, "DefaultGateway", "defaultGateway", "ipv4DefaultGateway");
        var primaryDns = FirstNonEmpty(element, "PrimaryDNS", "primaryDNS", "dnsServer1IpAddr", "DNS1");
        var secondaryDns = FirstNonEmpty(element, "SecondaryDNS", "secondaryDNS", "dnsServer2IpAddr", "DNS2");
        var dhcpMode = FirstNonEmpty(element, "addressingType", "ipAddressingType", "dhcp", "DHCP");

        return new NetworkInterfaceInfo(
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
        return document.Descendants().FirstOrDefault(element =>
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

        var localNameMatch = root.DescendantsAndSelf().FirstOrDefault(item => item.Name.LocalName.Equals(localName, StringComparison.OrdinalIgnoreCase));
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

    private static EzvizStatusInfo ParseEzvizStatus(XDocument document)
    {
        var enabledValue = GetValue(document.Root, "enabled");
        var registerStatusValue = GetValue(document.Root, "registerStatus");
        var verificationCode = GetValue(document.Root, "verificationCode");

        return new EzvizStatusInfo(
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
