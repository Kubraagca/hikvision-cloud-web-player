using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Caching.Memory;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddMemoryCache();
builder.Services.AddHttpClient<HikConnectGatewayClient>(client =>
{
    client.Timeout = TimeSpan.FromSeconds(30);
    client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
});
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
});
builder.Services.AddSingleton<HikConnectGatewayService>();

var app = builder.Build();

app.MapGet("/", () => Results.Ok(new { service = "HikConnect.TeamBackend", date = "2026-07-22" }));

app.MapPost("/api/team-devices/add", async (
    TeamDeviceAddRequest request,
    HikConnectGatewayService service,
    CancellationToken cancellationToken) =>
{
    var result = await service.AddDeviceAsync(request, cancellationToken);
    return result.Success
        ? Results.Ok(result)
        : Results.BadRequest(result);
});

app.Run();

internal sealed class HikConnectGatewayService
{
    private readonly HikConnectGatewayClient _client;

    public HikConnectGatewayService(HikConnectGatewayClient client)
    {
        _client = client;
    }

    public async Task<TeamDeviceAddResult> AddDeviceAsync(TeamDeviceAddRequest request, CancellationToken cancellationToken)
    {
        try
        {
            var alias = string.IsNullOrWhiteSpace(request.Alias)
                ? $"CAM-{request.ShortSerial}"
                : request.Alias.Trim();

            var areaName = string.IsNullOrWhiteSpace(request.AreaName)
                ? alias
                : request.AreaName.Trim();

            var area = await EnsureAreaAsync(areaName, cancellationToken);
            var existingDetail = await _client.TryGetDeviceDetailAsync(request.ShortSerial, cancellationToken);

            var deviceAdded = false;
            var deviceStatusMessage = string.Empty;
            var deviceId = existingDetail.DeviceId;

            if (!existingDetail.Exists)
            {
                var payload = new JsonObject
                {
                    ["deviceCategory"] = "encodingDevice",
                    ["deviceInfo"] = new JsonObject
                    {
                        ["name"] = alias,
                        ["ezvizSerialNo"] = request.ShortSerial,
                        ["ezvizVerifyCode"] = request.VerificationCode,
                        ["userName"] = "",
                        ["password"] = "",
                        ["streamSecretKey"] = ""
                    },
                    ["importToArea"] = new JsonObject
                    {
                        ["areaID"] = area.AreaId,
                        ["enable"] = "1"
                    },
                    ["timeZone"] = new JsonObject
                    {
                        ["id"] = "26",
                        ["applyToDevice"] = "1"
                    }
                };

                var response = await _client.PostWithTokenRetryAsync(
                    "/api/hccgw/resource/v1/devices/add",
                    payload,
                    cancellationToken);

                var addResult = HikConnectResponseParser.ParseDeviceAdd(response, request.ShortSerial, alias);
                if (!addResult.Success)
                {
                    return addResult with
                    {
                        AreaId = area.AreaId,
                        AreaName = area.AreaName
                    };
                }

                deviceAdded = true;
                deviceId = addResult.DeviceId;
                deviceStatusMessage = $"Cihaz eklendi. Area: {area.AreaName} ({area.AreaId}).";
            }
            else
            {
                deviceStatusMessage = "Cihaz zaten Team hesabinda vardi; tekrar eklenmedi.";
            }

            var detail = existingDetail.Exists
                ? existingDetail
                : await _client.GetRequiredDeviceDetailAsync(request.ShortSerial, cancellationToken);

            if (string.IsNullOrWhiteSpace(deviceId))
            {
                deviceId = detail.DeviceId;
            }

            if (detail.CameraChannels.Count == 0)
            {
                return new TeamDeviceAddResult(
                    false,
                    detail.ErrorCode is { Length: > 0 } ? detail.ErrorCode : "NO_CAMERA_CHANNEL",
                    "devicedetail/get yanitinda cameraChannel listesi bulunamadi.",
                    deviceId,
                    request.ShortSerial,
                    alias,
                    area.AreaId,
                    area.AreaName,
                    deviceAdded,
                    0,
                    0,
                    deviceStatusMessage,
                    "Kamera kanali bulunamadi.");
            }

            var importedChannelCount = 0;
            string channelStatusMessage;

            if (deviceAdded)
            {
                channelStatusMessage = "Cihaz importToArea enable=1 ile eklendi; portalda manuel import gerekmiyor.";
            }
            else
            {
                var channelsToImport = detail.CameraChannels
                    .Where(channel => !channel.AreaIds.Contains(area.AreaId, StringComparer.OrdinalIgnoreCase))
                    .ToList();

                foreach (var channel in channelsToImport)
                {
                    var payload = new JsonObject
                    {
                        ["areaID"] = area.AreaId,
                        ["devChannel"] = new JsonArray
                        {
                            new JsonObject
                            {
                                ["resourceName"] = alias,
                                ["resourceType"] = "camera",
                                ["channelID"] = channel.Id
                            }
                        }
                    };

                    var response = await _client.PostWithTokenRetryAsync(
                        "/api/hccgw/resource/v1/areas/resources/add",
                        payload,
                        cancellationToken);

                    HikConnectResponseParser.EnsureSuccess(response, "areas/resources/add");
                    importedChannelCount++;
                }

                channelStatusMessage = importedChannelCount > 0
                    ? $"{importedChannelCount} kamera kanali alana aktarildi."
                    : "Tum kamera kanallari secili alandaydi; tekrar import yapilmadi.";
            }

            return new TeamDeviceAddResult(
                true,
                "0",
                "Kurulum tamamlandi.",
                deviceId,
                request.ShortSerial,
                alias,
                area.AreaId,
                area.AreaName,
                deviceAdded,
                importedChannelCount,
                detail.CameraChannels.Count,
                deviceStatusMessage,
                channelStatusMessage);
        }
        catch (HikConnectApiException exception)
        {
            return new TeamDeviceAddResult(
                false,
                exception.ErrorCode,
                exception.Message,
                string.Empty,
                request.ShortSerial,
                string.IsNullOrWhiteSpace(request.Alias) ? $"CAM-{request.ShortSerial}" : request.Alias.Trim(),
                string.Empty,
                string.IsNullOrWhiteSpace(request.AreaName) ? $"CAM-{request.ShortSerial}" : request.AreaName.Trim(),
                false,
                0,
                0,
                "Cihaz ekleme asamasi tamamlanamadi.",
                "Kanal import asamasi baslatilamadi.");
        }
        catch (Exception exception)
        {
            return new TeamDeviceAddResult(
                false,
                "UNEXPECTED",
                exception.Message,
                string.Empty,
                request.ShortSerial,
                string.IsNullOrWhiteSpace(request.Alias) ? $"CAM-{request.ShortSerial}" : request.Alias.Trim(),
                string.Empty,
                string.IsNullOrWhiteSpace(request.AreaName) ? $"CAM-{request.ShortSerial}" : request.AreaName.Trim(),
                false,
                0,
                0,
                "Cihaz ekleme asamasi tamamlanamadi.",
                "Kanal import asamasi baslatilamadi.");
        }
    }

    private async Task<AreaInfo> EnsureAreaAsync(string areaName, CancellationToken cancellationToken)
    {
        var areas = await GetAreasAsync(cancellationToken);
        var existing = areas.FirstOrDefault(area => string.Equals(area.AreaName, areaName, StringComparison.OrdinalIgnoreCase));
        if (existing is not null)
        {
            return existing;
        }

        var addPayload = new JsonObject
        {
            ["parentAreaID"] = "-1",
            ["areaName"] = areaName
        };

        var addResponse = await _client.PostWithTokenRetryAsync(
            "/api/hccgw/resource/v1/areas/add",
            addPayload,
            cancellationToken);

        var outerErrorCode = HikConnectResponseParser.GetOuterErrorCode(addResponse);
        if (outerErrorCode == "0")
        {
            var createdAreaId = HikConnectResponseParser.ExtractFirstString(addResponse["data"], "areaID");
            if (!string.IsNullOrWhiteSpace(createdAreaId))
            {
                return new AreaInfo(createdAreaId, areaName);
            }
        }

        areas = await GetAreasAsync(cancellationToken);
        existing = areas.FirstOrDefault(area => string.Equals(area.AreaName, areaName, StringComparison.OrdinalIgnoreCase));
        if (existing is not null)
        {
            return existing;
        }

        HikConnectResponseParser.EnsureSuccess(addResponse, "areas/add");
        throw new HikConnectApiException("AREA_NOT_FOUND_AFTER_ADD", $"Alan olusturuldu ancak areaID bulunamadi. areaName={areaName}");
    }

    private async Task<IReadOnlyList<AreaInfo>> GetAreasAsync(CancellationToken cancellationToken)
    {
        var payload = new JsonObject
        {
            ["pageIndex"] = 1,
            ["pageSize"] = 500,
            ["filter"] = new JsonObject
            {
                ["parentAreaID"] = "-1",
                ["includeSubArea"] = 1
            }
        };

        var response = await _client.PostWithTokenRetryAsync(
            "/api/hccgw/resource/v1/areas/get",
            payload,
            cancellationToken);

        HikConnectResponseParser.EnsureSuccess(response, "areas/get");
        return HikConnectResponseParser.ParseAreas(response);
    }
}

internal sealed class HikConnectGatewayClient
{
    private const string CacheKey = "hikconnect-token-cache";
    private readonly HttpClient _httpClient;
    private readonly IMemoryCache _cache;
    private readonly IConfiguration _configuration;

    public HikConnectGatewayClient(HttpClient httpClient, IMemoryCache cache, IConfiguration configuration)
    {
        _httpClient = httpClient;
        _cache = cache;
        _configuration = configuration;
    }

    public async Task<JsonObject> PostWithTokenRetryAsync(string path, JsonObject payload, CancellationToken cancellationToken)
    {
        var tokenInfo = await GetTokenAsync(forceRefresh: false, cancellationToken);
        var response = await PostAsync(tokenInfo.AreaDomain, path, payload, tokenInfo.Token, cancellationToken);
        var outerCode = HikConnectResponseParser.GetOuterErrorCode(response);

        if (string.Equals(outerCode, "OPEN000007", StringComparison.OrdinalIgnoreCase))
        {
            tokenInfo = await GetTokenAsync(forceRefresh: true, cancellationToken);
            response = await PostAsync(tokenInfo.AreaDomain, path, payload, tokenInfo.Token, cancellationToken);
        }

        return response;
    }

    public async Task<DeviceDetailResult> TryGetDeviceDetailAsync(string shortSerial, CancellationToken cancellationToken)
    {
        var payload = new JsonObject
        {
            ["deviceSerialNo"] = shortSerial
        };

        var response = await PostWithTokenRetryAsync(
            "/api/hccgw/resource/v1/devicedetail/get",
            payload,
            cancellationToken);

        var outerCode = HikConnectResponseParser.GetOuterErrorCode(response);
        if (outerCode != "0")
        {
            var outerMessage = HikConnectResponseParser.GetOuterMessage(response);
            return new DeviceDetailResult(
                false,
                outerCode,
                HikConnectResponseParser.ToFriendlyMessage(outerCode, outerMessage),
                string.Empty,
                []);
        }

        var data = response["data"]?.AsObject();
        var deviceId = HikConnectResponseParser.ExtractDeviceId(data) ?? string.Empty;
        var channels = HikConnectResponseParser.ParseCameraChannels(data);
        var exists = !string.IsNullOrWhiteSpace(deviceId)
            || channels.Count > 0
            || !string.IsNullOrWhiteSpace(HikConnectResponseParser.ExtractFirstString(data, "deviceSerialNo"));

        return new DeviceDetailResult(
            exists,
            "0",
            string.Empty,
            deviceId,
            channels);
    }

    public async Task<DeviceDetailResult> GetRequiredDeviceDetailAsync(string shortSerial, CancellationToken cancellationToken)
    {
        var detail = await TryGetDeviceDetailAsync(shortSerial, cancellationToken);
        if (!detail.Exists)
        {
            throw new HikConnectApiException(
                detail.ErrorCode is { Length: > 0 } ? detail.ErrorCode : "DEVICE_DETAIL_NOT_FOUND",
                string.IsNullOrWhiteSpace(detail.ErrorMessage)
                    ? "devicedetail/get ile cihaz detaylari okunamadi."
                    : detail.ErrorMessage);
        }

        return detail;
    }

    private async Task<HikConnectTokenInfo> GetTokenAsync(bool forceRefresh, CancellationToken cancellationToken)
    {
        if (!forceRefresh && _cache.TryGetValue(CacheKey, out HikConnectTokenInfo? cached) && cached is not null)
        {
            return cached;
        }

        var baseUrl = _configuration["HikConnect:BaseUrl"] ?? Environment.GetEnvironmentVariable("HIKCONNECT__BASEURL") ?? "https://api.hik-connect.com";
        var appKey = _configuration["HikConnect:AppKey"] ?? Environment.GetEnvironmentVariable("HIKCONNECT__APPKEY");
        var secretKey = _configuration["HikConnect:SecretKey"] ?? Environment.GetEnvironmentVariable("HIKCONNECT__SECRETKEY");

        if (string.IsNullOrWhiteSpace(appKey) || string.IsNullOrWhiteSpace(secretKey))
        {
            throw new InvalidOperationException("Hik-Connect AppKey/SecretKey backend tarafinda tanimli degil. Environment variable veya User Secrets kullanin.");
        }

        var payload = new JsonObject
        {
            ["appKey"] = appKey,
            ["secretKey"] = secretKey
        };

        using var request = new HttpRequestMessage(HttpMethod.Post, CombineUrl(baseUrl, "/api/hccgw/platform/v1/token/get"))
        {
            Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json")
        };

        using var response = await _httpClient.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        response.EnsureSuccessStatusCode();

        var json = JsonNode.Parse(body)?.AsObject() ?? throw new InvalidOperationException("Token yaniti parse edilemedi.");
        var outerErrorCode = HikConnectResponseParser.GetOuterErrorCode(json);
        if (!string.IsNullOrWhiteSpace(outerErrorCode) && outerErrorCode != "0")
        {
            throw new HikConnectApiException(outerErrorCode, HikConnectResponseParser.ToFriendlyMessage(outerErrorCode, HikConnectResponseParser.GetOuterMessage(json)));
        }

        var data = json["data"]?.AsObject() ?? throw new InvalidOperationException("Token yanitinda data bulunamadi.");
        var token = data["token"]?.GetValue<string>() ?? throw new InvalidOperationException("Token yanitinda token bulunamadi.");
        var areaDomain = data["areaDomain"]?.GetValue<string>() ?? throw new InvalidOperationException("Token yanitinda areaDomain bulunamadi.");
        var expireSeconds = data["expire"]?.GetValue<int?>() ?? 3600;

        var tokenInfo = new HikConnectTokenInfo(token, areaDomain, DateTimeOffset.UtcNow.AddSeconds(Math.Max(60, expireSeconds - 60)));
        _cache.Set(CacheKey, tokenInfo, tokenInfo.ExpiresAt);
        return tokenInfo;
    }

    private async Task<JsonObject> PostAsync(string areaDomain, string path, JsonObject payload, string token, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, CombineUrl(areaDomain, path))
        {
            Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json")
        };
        request.Headers.TryAddWithoutValidation("Token", token);

        using var response = await _httpClient.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        response.EnsureSuccessStatusCode();
        return JsonNode.Parse(body)?.AsObject() ?? throw new InvalidOperationException("Hik-Connect yaniti parse edilemedi.");
    }

    private static string CombineUrl(string baseUrl, string path)
    {
        return $"{baseUrl.TrimEnd('/')}/{path.TrimStart('/')}";
    }
}

internal static class HikConnectResponseParser
{
    public static string GetOuterErrorCode(JsonObject response)
    {
        return response["errorCode"]?.GetValue<string>()
            ?? response["code"]?.GetValue<string>()
            ?? string.Empty;
    }

    public static string GetOuterMessage(JsonObject response)
    {
        return response["errorMsg"]?.GetValue<string>()
            ?? response["msg"]?.GetValue<string>()
            ?? string.Empty;
    }

    public static void EnsureSuccess(JsonObject response, string endpointName)
    {
        var outerErrorCode = GetOuterErrorCode(response);
        if (!string.IsNullOrWhiteSpace(outerErrorCode) && outerErrorCode != "0")
        {
            throw new HikConnectApiException(outerErrorCode, ToFriendlyMessage(outerErrorCode, $"{endpointName} basarisiz."));
        }

        var innerErrorCode = FirstInnerNonZeroErrorCode(response["data"]);
        if (!string.IsNullOrWhiteSpace(innerErrorCode))
        {
            throw new HikConnectApiException(innerErrorCode, ToFriendlyMessage(innerErrorCode, $"{endpointName} ic hata dondu."));
        }
    }

    public static TeamDeviceAddResult ParseDeviceAdd(JsonObject response, string shortSerial, string alias)
    {
        var outerErrorCode = GetOuterErrorCode(response);
        var outerMessage = GetOuterMessage(response);

        var data = response["data"]?.AsObject();
        var succeeded = data?["succeeded"]?.GetValue<int?>() ?? 0;
        var failed = data?["failed"]?.GetValue<int?>() ?? 0;

        var deviceId = ExtractDeviceId(data);
        var success = outerErrorCode == "0" && failed == 0 && succeeded == 1 && !string.IsNullOrWhiteSpace(deviceId);

        var effectiveErrorCode = success ? "0" : FirstInnerErrorCode(data) ?? outerErrorCode;
        var userMessage = success
            ? "Cihaz Team hesabina basariyla eklendi."
            : ToFriendlyMessage(effectiveErrorCode, outerMessage);

        return new TeamDeviceAddResult(
            success,
            effectiveErrorCode,
            userMessage,
            deviceId ?? string.Empty,
            shortSerial,
            alias,
            string.Empty,
            string.Empty,
            success,
            0,
            0,
            success ? "Cihaz eklendi." : "Cihaz eklenemedi.",
            string.Empty);
    }

    public static IReadOnlyList<AreaInfo> ParseAreas(JsonObject response)
    {
        var results = new Dictionary<string, AreaInfo>(StringComparer.OrdinalIgnoreCase);

        foreach (var node in EnumerateNodes(response["data"]))
        {
            if (node is not JsonObject obj)
            {
                continue;
            }

            var areaId = GetString(obj, "areaID");
            var areaName = GetString(obj, "areaName");
            if (string.IsNullOrWhiteSpace(areaId) || string.IsNullOrWhiteSpace(areaName))
            {
                continue;
            }

            results[areaId] = new AreaInfo(areaId, areaName);
        }

        return results.Values.ToList();
    }

    public static IReadOnlyList<CameraChannelInfo> ParseCameraChannels(JsonObject? data)
    {
        var channels = new List<CameraChannelInfo>();

        foreach (var channelArray in FindNamedArrays(data, "cameraChannel"))
        {
            foreach (var node in channelArray)
            {
                if (node is not JsonObject obj)
                {
                    continue;
                }

                var id = GetString(obj, "id") ?? GetString(obj, "channelID") ?? GetString(obj, "channelId");
                if (string.IsNullOrWhiteSpace(id))
                {
                    continue;
                }

                var areaIds = FindNamedStringValues(obj, "areaID")
                    .Concat(FindNamedStringValues(obj, "areaId"))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList();

                channels.Add(new CameraChannelInfo(id, areaIds));
            }
        }

        return channels;
    }

    public static string? ExtractDeviceId(JsonObject? data)
    {
        if (data is null)
        {
            return null;
        }

        foreach (var node in EnumerateNodes(data))
        {
            if (node is JsonObject obj
                && obj["deviceId"] is JsonValue value
                && value.TryGetValue<string>(out var deviceId)
                && !string.IsNullOrWhiteSpace(deviceId))
            {
                return deviceId;
            }
        }

        return null;
    }

    public static string? ExtractFirstString(JsonNode? node, string propertyName)
    {
        foreach (var item in EnumerateNodes(node))
        {
            if (item is JsonObject obj)
            {
                var value = GetString(obj, propertyName);
                if (!string.IsNullOrWhiteSpace(value))
                {
                    return value;
                }
            }
        }

        return null;
    }

    public static string ToFriendlyMessage(string errorCode, string fallback)
    {
        return errorCode switch
        {
            "OPEN000007" => "Token hatasi olustu; backend tokeni bir kez yenileyip yeniden denedi. Islem hala basarisizsa backend ayarlarini kontrol edin.",
            "LAP000001" => "Hik-Connect isteginde giris parametresi hatasi var.",
            "EVZ20007" => "Cihaz Hik-Connect tarafinda cevrimdisi gorunuyor. Gateway ve DNS ayarlarini kontrol edin.",
            "EVZ20010" => "Verification code hatali. Kameradaki EZVIZ verification code ile backend istegi ayni olmali.",
            "EVZ20013" => "Cihaz baska bir Hik-Connect hesabina eklenmis.",
            _ => string.IsNullOrWhiteSpace(fallback)
                ? $"Hik-Connect istegi basarisiz. errorCode={errorCode}"
                : $"{fallback} (errorCode={errorCode})"
        };
    }

    private static string? FirstInnerErrorCode(JsonObject? data)
    {
        if (data is null)
        {
            return null;
        }

        foreach (var node in EnumerateNodes(data))
        {
            if (node is JsonObject obj
                && obj["errorCode"] is JsonValue value
                && value.TryGetValue<string>(out var errorCode)
                && !string.IsNullOrWhiteSpace(errorCode))
            {
                return errorCode;
            }
        }

        return null;
    }

    private static string? FirstInnerNonZeroErrorCode(JsonNode? data)
    {
        foreach (var node in EnumerateNodes(data))
        {
            if (node is JsonObject obj
                && obj["errorCode"] is JsonValue value
                && value.TryGetValue<string>(out var errorCode)
                && !string.IsNullOrWhiteSpace(errorCode)
                && errorCode != "0")
            {
                return errorCode;
            }
        }

        return null;
    }

    private static IEnumerable<JsonArray> FindNamedArrays(JsonNode? node, string propertyName)
    {
        if (node is null)
        {
            yield break;
        }

        if (node is JsonObject obj)
        {
            foreach (var property in obj)
            {
                if (string.Equals(property.Key, propertyName, StringComparison.OrdinalIgnoreCase)
                    && property.Value is JsonArray array)
                {
                    yield return array;
                }

                foreach (var child in FindNamedArrays(property.Value, propertyName))
                {
                    yield return child;
                }
            }
        }
        else if (node is JsonArray array)
        {
            foreach (var child in array)
            {
                foreach (var descendant in FindNamedArrays(child, propertyName))
                {
                    yield return descendant;
                }
            }
        }
    }

    private static IEnumerable<string> FindNamedStringValues(JsonNode? node, string propertyName)
    {
        foreach (var item in EnumerateNodes(node))
        {
            if (item is JsonObject obj)
            {
                var value = GetString(obj, propertyName);
                if (!string.IsNullOrWhiteSpace(value))
                {
                    yield return value;
                }
            }
        }
    }

    private static string? GetString(JsonObject obj, string propertyName)
    {
        if (!obj.TryGetPropertyValue(propertyName, out var node) || node is null)
        {
            return null;
        }

        return node switch
        {
            JsonValue value when value.TryGetValue<string>(out var text) => text,
            JsonValue value when value.TryGetValue<int>(out var intValue) => intValue.ToString(),
            JsonValue value when value.TryGetValue<long>(out var longValue) => longValue.ToString(),
            _ => node.ToJsonString().Trim('"')
        };
    }

    private static IEnumerable<JsonNode?> EnumerateNodes(JsonNode? node)
    {
        if (node is null)
        {
            yield break;
        }

        yield return node;

        switch (node)
        {
            case JsonObject obj:
                foreach (var child in obj)
                {
                    foreach (var descendant in EnumerateNodes(child.Value))
                    {
                        yield return descendant;
                    }
                }
                break;

            case JsonArray array:
                foreach (var child in array)
                {
                    foreach (var descendant in EnumerateNodes(child))
                    {
                        yield return descendant;
                    }
                }
                break;
        }
    }
}

internal sealed class HikConnectApiException : Exception
{
    public HikConnectApiException(string errorCode, string message)
        : base(message)
    {
        ErrorCode = errorCode;
    }

    public string ErrorCode { get; }
}

internal sealed record HikConnectTokenInfo(string Token, string AreaDomain, DateTimeOffset ExpiresAt);

internal sealed record AreaInfo(string AreaId, string AreaName);

internal sealed record CameraChannelInfo(string Id, IReadOnlyList<string> AreaIds);

internal sealed record DeviceDetailResult(
    bool Exists,
    string ErrorCode,
    string ErrorMessage,
    string DeviceId,
    IReadOnlyList<CameraChannelInfo> CameraChannels);

internal sealed record TeamDeviceAddRequest(
    string ShortSerial,
    string VerificationCode,
    string? Alias,
    string? AreaName);

internal sealed record TeamDeviceAddResult(
    bool Success,
    string ErrorCode,
    string Message,
    string DeviceId,
    string ShortSerial,
    string Alias,
    string AreaId,
    string AreaName,
    bool DeviceAdded,
    int ImportedChannelCount,
    int TotalChannelCount,
    string DeviceStatusMessage,
    string ChannelStatusMessage);
