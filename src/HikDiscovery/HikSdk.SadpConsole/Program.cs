using System.Text.Json;
using HikSdk.Interop;

var command = args.Length > 0 ? args[0].Trim().ToLowerInvariant() : "sadp-test";

try
{
    switch (command)
    {
        case "activate":
            await RunActivateAsync(args.Skip(1).ToArray());
            break;

        case "sadp-test":
            await RunSadpTestAsync();
            break;

        default:
            throw new InvalidOperationException($"Bilinmeyen komut: {command}");
    }
}
catch (Exception exception)
{
    await WriteJsonAsync(new
    {
        success = false,
        error = exception.Message
    });
    Environment.ExitCode = 1;
}

static async Task RunActivateAsync(string[] args)
{
    var options = ParseNamedArgs(args);
    var ip = GetRequired(options, "ip");
    var password = options.TryGetValue("password", out var explicitPassword) && !string.IsNullOrWhiteSpace(explicitPassword)
        ? explicitPassword
        : Environment.GetEnvironmentVariable("HIKSDK_ACTIVATE_PASSWORD");
    if (string.IsNullOrWhiteSpace(password))
    {
        throw new InvalidOperationException("Eksik parametre: --password veya HIKSDK_ACTIVATE_PASSWORD");
    }
    var port = ushort.TryParse(options.GetValueOrDefault("port"), out var parsedPort) ? parsedPort : (ushort)8000;
    var logDir = options.GetValueOrDefault("logDir");
    var baseDirectory = AppContext.BaseDirectory;
    var effectiveLogDir = string.IsNullOrWhiteSpace(logDir)
        ? Path.Combine(baseDirectory, "sdk-logs")
        : logDir!;

    using var session = new HikActivationSession();
    session.Initialize(effectiveLogDir);
    var activationResult = session.ActivateDevice(ip, port, password);

    await WriteJsonAsync(new
    {
        success = activationResult.Success,
        errorCode = activationResult.ErrorCode,
        errorMessage = activationResult.ErrorMessage
    });

    if (!activationResult.Success)
    {
        Environment.ExitCode = 1;
    }
}

static async Task RunSadpTestAsync()
{
    var baseDirectory = AppContext.BaseDirectory;
    var logDirectory = Path.Combine(baseDirectory, "sdk-logs");

    Console.WriteLine("HCNetSDK SADP discovery console test");
    Console.WriteLine($"Base directory: {baseDirectory}");
    Console.WriteLine($"Log directory: {logDirectory}");
    Console.WriteLine();

    foreach (var size in SadpInteropValidator.Validate())
    {
        Console.WriteLine($"{size.Name}: expected={size.ExpectedSize}, actual={size.ActualSize}, match={size.IsMatch}");
    }

    Console.WriteLine();

    using var session = new HikSdkSession();
    session.Initialize();
    session.EnableLogging(logDirectory);

    var finishedAt = DateTimeOffset.Now.AddSeconds(15);
    var iteration = 0;

    while (DateTimeOffset.Now < finishedAt)
    {
        iteration++;
        Console.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss}] SADP poll #{iteration}");

        var result = session.PollSadpDevices();
        if (!result.Success)
        {
            Console.WriteLine($"  Failed. NET_DVR_GetLastError={result.ErrorCode}, Message={result.ErrorMessage}");
        }
        else if (result.Devices.Count == 0)
        {
            Console.WriteLine("  No devices reported by NET_DVR_GetSadpInfoList.");
        }
        else
        {
            for (var i = 0; i < result.Devices.Count; i++)
            {
                var device = result.Devices[i];
                Console.WriteLine($"  Device #{i + 1}");
                Console.WriteLine($"    Model: {device.Model}");
                Console.WriteLine($"    Serial: {device.SerialNumber}");
                Console.WriteLine($"    MAC: {device.MacAddress}");
                Console.WriteLine($"    IP: {device.IpAddress}");
                Console.WriteLine($"    DHCP: {(device.DhcpEnabled ? "Enabled" : "Disabled")}");
                Console.WriteLine($"    Activation: {device.ActivationStatus}");
            }
        }

        Console.WriteLine();
        await Task.Delay(TimeSpan.FromSeconds(2));
    }
}

static Dictionary<string, string> ParseNamedArgs(string[] args)
{
    var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    for (var i = 0; i < args.Length; i++)
    {
        var current = args[i];
        if (!current.StartsWith("--", StringComparison.Ordinal))
        {
            continue;
        }

        var key = current[2..];
        var value = i + 1 < args.Length ? args[i + 1] : string.Empty;
        result[key] = value;
        i++;
    }

    return result;
}

static string GetRequired(IReadOnlyDictionary<string, string> args, string key)
{
    if (args.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value))
    {
        return value;
    }

    throw new InvalidOperationException($"Eksik parametre: --{key}");
}

static async Task WriteJsonAsync(object payload)
{
    await Console.Out.WriteLineAsync(JsonSerializer.Serialize(payload));
}
