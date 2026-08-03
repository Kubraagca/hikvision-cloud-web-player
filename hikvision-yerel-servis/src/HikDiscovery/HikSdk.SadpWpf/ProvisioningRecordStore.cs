using System.IO;
using System.Text.Json;

namespace HikSdk.SadpWpf;

public sealed class ProvisioningRecordStore
{
    private readonly string _filePath;

    public ProvisioningRecordStore()
    {
        var directory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "HikvisionProvisioning");
        Directory.CreateDirectory(directory);
        _filePath = Path.Combine(directory, "provisioned-cameras.json");
    }

    public async Task SaveAsync(ProvisionedCameraRecord record, CancellationToken cancellationToken)
    {
        var records = await LoadAsync(cancellationToken).ConfigureAwait(false);
        var filtered = records
            .Where(item => !string.Equals(item.ShortSerial, record.ShortSerial, StringComparison.OrdinalIgnoreCase))
            .ToList();
        filtered.Add(record);

        await using var stream = File.Create(_filePath);
        await JsonSerializer.SerializeAsync(stream, filtered, cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    private async Task<List<ProvisionedCameraRecord>> LoadAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(_filePath))
        {
            return [];
        }

        await using var stream = File.OpenRead(_filePath);
        var records = await JsonSerializer.DeserializeAsync<List<ProvisionedCameraRecord>>(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
        return records ?? [];
    }
}
