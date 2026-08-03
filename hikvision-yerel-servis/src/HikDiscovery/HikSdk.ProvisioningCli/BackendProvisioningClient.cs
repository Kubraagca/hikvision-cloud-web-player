using System.Net.Http.Json;

namespace HikSdk.ProvisioningCli;

public sealed class BackendProvisioningClient : IDisposable
{
    private readonly HttpClient _httpClient;

    public BackendProvisioningClient(string baseUrl)
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

    public async Task<BackendProvisioningResponse> RegisterProvisionedDeviceAsync(BackendProvisioningRequest request, CancellationToken cancellationToken)
    {
        using var response = await _httpClient.PostAsJsonAsync("api/provisioning/team-register", request, cancellationToken).ConfigureAwait(false);
        var result = await response.Content.ReadFromJsonAsync<BackendProvisioningResponse>(cancellationToken: cancellationToken).ConfigureAwait(false);
        if (result is null)
        {
            throw new InvalidOperationException("Backend yaniti okunamadi.");
        }

        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(result.Error ?? "Backend provisioning istegi basarisiz.");
        }

        return result;
    }

    public void Dispose() => _httpClient.Dispose();
}
