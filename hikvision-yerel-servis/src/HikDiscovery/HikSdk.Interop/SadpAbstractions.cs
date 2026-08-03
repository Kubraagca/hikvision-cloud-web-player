namespace HikSdk.Interop;

public interface IDeviceDiscoveryService
{
    Task<SadpPollResult> DiscoverAsync(CancellationToken cancellationToken = default);
}

public sealed class SadpDiscoveryService : IDeviceDiscoveryService, IDisposable
{
    private readonly HikSdkSession _session = new();
    private readonly string _logDirectory;
    private bool _initialized;

    public SadpDiscoveryService(string logDirectory)
    {
        _logDirectory = logDirectory;
    }

    public Task<SadpPollResult> DiscoverAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        EnsureInitialized();
        return Task.FromResult(_session.PollSadpDevices());
    }

    public void Dispose()
    {
        _session.Dispose();
    }

    private void EnsureInitialized()
    {
        if (_initialized)
        {
            return;
        }

        _session.Initialize();
        _session.EnableLogging(_logDirectory);
        _initialized = true;
    }
}
