using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;

namespace HikSdk.SadpWpf;

public sealed class TeamBackendClient : IDisposable
{
    private readonly HttpClient _httpClient;
    private readonly Action<ApiTraceEntry>? _trace;

    public TeamBackendClient(string baseUrl, Action<ApiTraceEntry>? trace = null)
    {
        if (string.IsNullOrWhiteSpace(baseUrl))
        {
            throw new InvalidOperationException("Backend adresi bos olamaz.");
        }

        _trace = trace;
        _httpClient = new HttpClient
        {
            BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/"),
            Timeout = TimeSpan.FromSeconds(30)
        };
    }

    public async Task<BackendAddDeviceResult> AddDeviceAsync(BackendAddDeviceRequest request, CancellationToken cancellationToken)
    {
        using var response = await _httpClient.PostAsJsonAsync("api/team-devices/add", request, cancellationToken).ConfigureAwait(false);
        var responseBody = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        Trace("Backend", "POST", "api/team-devices/add", JsonSerializer.Serialize(request), (int)response.StatusCode, responseBody);

        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"Backend cihaz ekleme istegi basarisiz. HTTP {(int)response.StatusCode} ({response.StatusCode}). Yanit: {Summarize(responseBody)}");
        }

        BackendAddDeviceResult? result;
        try
        {
            result = JsonSerializer.Deserialize<BackendAddDeviceResult>(responseBody, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });
        }
        catch (JsonException exception)
        {
            throw new InvalidOperationException(
                $"Backend yaniti beklenen JSON modeline donusturulemedi. Yanit: {Summarize(responseBody)}",
                exception);
        }

        if (result is null)
        {
            throw new InvalidOperationException("Backend yaniti okunamadi.");
        }

        return result;
    }

    public async Task CheckHealthAsync(CancellationToken cancellationToken)
    {
        using var response = await _httpClient.GetAsync("", cancellationToken).ConfigureAwait(false);
        var responseBody = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        Trace("Backend", "GET", "", string.Empty, (int)response.StatusCode, responseBody);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"Backend erisimi basarisiz. HTTP {(int)response.StatusCode} ({response.StatusCode}). Yanit: {Summarize(responseBody)}");
        }
    }

    public void Dispose()
    {
        _httpClient.Dispose();
    }

    private static string Summarize(string body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return "Bos yanit.";
        }

        var shortBody = string.Join(" ", body.Split(default(string[]), StringSplitOptions.RemoveEmptyEntries)).Trim();
        return shortBody.Length > 220 ? shortBody[..220] + "..." : shortBody;
    }

    private void Trace(string source, string method, string requestUri, string requestBody, int? statusCode, string responseBody)
    {
        _trace?.Invoke(new ApiTraceEntry(
            DateTimeOffset.Now,
            source,
            method,
            new Uri(_httpClient.BaseAddress!, requestUri).ToString(),
            statusCode,
            requestBody,
            responseBody));
    }
}
