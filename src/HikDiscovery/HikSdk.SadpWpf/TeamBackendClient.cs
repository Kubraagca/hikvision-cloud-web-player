using System.Net.Http;
using System.Net.Http.Json;

namespace HikSdk.SadpWpf;

public sealed class TeamBackendClient : IDisposable
{
    private readonly HttpClient _httpClient;

    public TeamBackendClient(string baseUrl)
    {
        if (string.IsNullOrWhiteSpace(baseUrl))
        {
            throw new InvalidOperationException("Backend adresi bos olamaz.");
        }

        _httpClient = new HttpClient
        {
            BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/"),
            Timeout = TimeSpan.FromSeconds(30)
        };
    }

    public async Task<BackendAddDeviceResult> AddDeviceAsync(BackendAddDeviceRequest request, CancellationToken cancellationToken)
    {
        using var response = await _httpClient.PostAsJsonAsync("api/team-devices/add", request, cancellationToken).ConfigureAwait(false);
        var result = await response.Content.ReadFromJsonAsync<BackendAddDeviceResult>(cancellationToken: cancellationToken).ConfigureAwait(false);
        if (result is null)
        {
            throw new InvalidOperationException("Backend yaniti okunamadi.");
        }

        return result;
    }

    public void Dispose()
    {
        _httpClient.Dispose();
    }
}
