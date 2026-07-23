using System.Diagnostics;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using HikSdk.Interop;

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://127.0.0.1:47831");
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy
            .AllowAnyHeader()
            .AllowAnyMethod()
            .SetIsOriginAllowed(_ => true));
});
builder.Services.AddSingleton<AgentTaskStore>();
builder.Services.AddSingleton<LocalDiscoveryService>();

var app = builder.Build();
app.UseCors();
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/", () => Results.Redirect("/camera-setup.html"));
app.MapGet("/camera-setup", () => Results.Redirect("/camera-setup.html"));

app.MapGet("/agent/health", () => Results.Ok(new
{
    ok = true,
    service = "HikProvisioning.Agent",
    version = "2026-07-23",
    cli = CliRunner.GetCliStatus()
}));

app.MapPost("/agent/discover", async (DiscoverAgentRequest? request, LocalDiscoveryService discoveryService, CancellationToken cancellationToken) =>
{
    var result = await discoveryService.DiscoverAsync(
        request?.SubnetPrefix,
        request?.Concurrency ?? 32,
        request?.ScanSeconds ?? 12,
        cancellationToken);

    return Results.Json(new
    {
        success = true,
        method = "agent-network-scan",
        stage = "discover",
        timedOut = result.TimedOut,
        message = result.TimedOut ? "Tarama suresi doldu. Kismi sonuc donuldu." : "Tarama tamamlandi.",
        devices = result.Devices.Select(device => new
        {
            device.IpAddress,
            device.MacAddress,
            device.SerialNumber,
            device.Model,
            device.ActivationStatus,
            device.IsHikvision,
            device.SupportsIsapi,
            device.SupportsSdkPort
        })
    });
});

app.MapPost("/agent/provision/start", (ProvisionAgentRequest request, AgentTaskStore taskStore) =>
{
    var task = taskStore.Create("localSetup", request);
    _ = Task.Run(() => RunProvisionAsync(taskStore, task.TaskId, request));
    return Results.Accepted($"/agent/tasks/{task.TaskId}", new { taskId = task.TaskId });
});

app.MapPost("/agent/cloud-register/start", (ProvisionAgentRequest request, AgentTaskStore taskStore) =>
{
    var task = taskStore.Create("cloudRegister", request);
    _ = Task.Run(() => RunCloudRegisterAsync(taskStore, task.TaskId, request));
    return Results.Accepted($"/agent/tasks/{task.TaskId}", new { taskId = task.TaskId });
});

app.MapPost("/agent/connect/start", (ProvisionAgentRequest request, AgentTaskStore taskStore) =>
{
    var task = taskStore.Create("connect", request);
    _ = Task.Run(() => RunConnectAsync(taskStore, task.TaskId, request));
    return Results.Accepted($"/agent/tasks/{task.TaskId}", new { taskId = task.TaskId });
});

app.MapGet("/agent/tasks/{taskId}", (string taskId, AgentTaskStore taskStore) =>
{
    return taskStore.TryGet(taskId, out var task)
        ? Results.Ok(taskStore.ToResponse(task!))
        : Results.NotFound(new { error = "Task bulunamadi." });
});

app.MapPost("/agent/tasks/{taskId}/cancel", (string taskId, AgentTaskStore taskStore) =>
{
    return taskStore.TryCancel(taskId)
        ? Results.Ok(new { cancelled = true, taskId })
        : Results.NotFound(new { error = "Task bulunamadi." });
});

app.Run();

static async Task RunProvisionAsync(AgentTaskStore taskStore, string taskId, ProvisionAgentRequest request)
{
    taskStore.Update(taskId, status: "running", message: "Yerel kamera ayarlari gorevi baslatildi.");
    taskStore.SetStages(taskId,
    [
        new AgentTaskStage("Erisim", "Bekliyor", string.Empty),
        new AgentTaskStage("Aktivasyon", "Bekliyor", string.Empty),
        new AgentTaskStage("Giris", "Bekliyor", string.Empty),
        new AgentTaskStage("Ag Ayari", "Bekliyor", string.Empty),
        new AgentTaskStage("Hik-Connect Online", "Bekliyor", string.Empty),
        new AgentTaskStage("Tamamlandi", "Bekliyor", string.Empty)
    ]);
    taskStore.UpdateStage(taskId, "Erisim", "Calisiyor", "Yerel kamera ayarlari akisi baslatildi.");

    try
    {
        var token = taskStore.GetCancellation(taskId).Token;
        var options = new AgentCameraConnectionOptions(
            request.CameraAddress.Trim(),
            string.IsNullOrWhiteSpace(request.UserName) ? "admin" : request.UserName.Trim(),
            request.Password);

        var currentIpAddress = options.CameraAddress;
        var activationRequired = false;

        using var initialClient = new AgentCameraIsapiClient(options);
        try
        {
            var activateStatus = await initialClient.GetActivateStatusAsync(token).ConfigureAwait(false);
            activationRequired = activateStatus.IsInactive;
        }
        catch (AgentCameraIsapiException exception) when (
            exception.StatusCode == HttpStatusCode.Forbidden &&
            string.Equals(exception.SubStatusCode, "notActivated", StringComparison.OrdinalIgnoreCase))
        {
            activationRequired = true;
        }
        catch (AgentCameraIsapiException exception) when (LooksLikeAlreadyActiveActivateStatusFailure(exception))
        {
            activationRequired = false;
        }

        taskStore.UpdateStage(taskId, "Erisim", "Tamam", activationRequired ? "Kamera inactive bulundu." : "Kamera aktif.");

        if (activationRequired)
        {
            taskStore.UpdateStage(taskId, "Aktivasyon", "Calisiyor", "HCNetSDK ile kamera aktive ediliyor.");
            using var session = new HikActivationSession();
            session.Initialize(Path.Combine(AppContext.BaseDirectory, "sdk-logs"));
            var activationResult = session.ActivateDevice(currentIpAddress, request.SdkPort, options.Password);
            if (!activationResult.Success)
            {
                throw new InvalidOperationException($"NET_DVR_ActivateDevice basarisiz. NET_DVR_GetLastError={activationResult.ErrorCode}, Message={activationResult.ErrorMessage}");
            }

            taskStore.UpdateStage(taskId, "Aktivasyon", "Tamam", "Kamera aktive edildi.");
        }
        else
        {
            taskStore.UpdateStage(taskId, "Aktivasyon", "Atlandi", "Kamera zaten aktif.");
        }

        taskStore.UpdateStage(taskId, "Giris", "Calisiyor", "deviceInfo okunuyor ve HCNetSDK login dogrulaniyor.");
        var deviceInfo = activationRequired
            ? await initialClient.WaitForDeviceInfoAsync(TimeSpan.FromSeconds(90), TimeSpan.FromSeconds(3), token).ConfigureAwait(false)
            : await initialClient.GetDeviceInfoAsync(token).ConfigureAwait(false);

        using (var session = new HikActivationSession())
        {
            session.Initialize(Path.Combine(AppContext.BaseDirectory, "sdk-logs"));
            var loginResult = session.Login(currentIpAddress, request.SdkPort, options.UserName, options.Password);
            if (!loginResult.Success)
            {
                throw new InvalidOperationException($"NET_DVR_Login_V40 basarisiz. NET_DVR_GetLastError={loginResult.ErrorCode}, Message={loginResult.ErrorMessage}");
            }
        }

        taskStore.UpdateStage(taskId, "Giris", "Tamam", $"Model={deviceInfo.Model}, KisaSeri={deviceInfo.ShortSerial}");

        taskStore.UpdateStage(taskId, "Ag Ayari", "Calisiyor", "Ag bilgileri okunuyor ve gateway/DNS guncelleniyor.");
        var updatedInterfaces = await initialClient.UpdateGatewayDnsAsync(
            request.GatewayOverride,
            request.PrimaryDns ?? "8.8.8.8",
            request.SecondaryDns ?? "1.1.1.1",
            request.EnableDhcp,
            token).ConfigureAwait(false);

        if (request.EnableDhcp)
        {
            var foundIp = await initialClient.FindCameraIpInSubnetAsync(
                currentIpAddress,
                options.UserName,
                options.Password,
                deviceInfo.ShortSerial,
                deviceInfo.MacAddress,
                token).ConfigureAwait(false);

            if (!string.IsNullOrWhiteSpace(foundIp))
            {
                currentIpAddress = foundIp;
                options = options with { CameraAddress = currentIpAddress };
                using var updatedClient = new AgentCameraIsapiClient(options);
                updatedInterfaces = await updatedClient.GetNetworkInterfacesAsync(token).ConfigureAwait(false);
            }
        }

        taskStore.UpdateStage(taskId, "Ag Ayari", "Tamam", $"Guncel IP={currentIpAddress}");

        var verificationCode = string.IsNullOrWhiteSpace(request.VerificationCode)
            ? AgentCameraIsapiClient.CreateVerificationCode(12)
            : request.VerificationCode.Trim();

        using var activeClient = new AgentCameraIsapiClient(options with { CameraAddress = currentIpAddress });
        taskStore.UpdateStage(taskId, "Hik-Connect Online", "Calisiyor", "EZVIZ/Hik-Connect etkinlestiriliyor.");
        var ezvizResult = await activeClient.EnableEzvizAsync(
            verificationCode,
            TimeSpan.FromSeconds(5),
            TimeSpan.FromMinutes(2),
            token).ConfigureAwait(false);

        if (ezvizResult.TimedOut)
        {
            throw new InvalidOperationException("registerStatus iki dakika icinde true olmadi. Gateway ve DNS baglantisini kontrol edin.");
        }

        taskStore.UpdateStage(taskId, "Hik-Connect Online", "Tamam", "registerStatus=true oldu.");
        taskStore.UpdateStage(taskId, "Tamamlandi", "Tamam", "Yerel kamera ayarlari tamamlandi.");

        taskStore.Complete(taskId, "completed", JsonSerializer.Serialize(new
        {
            success = true,
            mode = "localSetup",
            device = new
            {
                deviceInfo.Model,
                deviceInfo.SerialNumber,
                deviceInfo.ShortSerial,
                deviceInfo.SubSerialNumber,
                deviceInfo.FirmwareVersion,
                deviceInfo.MacAddress,
                CurrentIpAddress = currentIpAddress
            },
            network = updatedInterfaces,
            ezviz = ezvizResult.FinalStatus,
            verificationCode,
            message = "Kamera aktif edildi, ag ayarlari uygulandi ve EZVIZ/Hik-Connect aktif edildi."
        }));
    }
    catch (OperationCanceledException)
    {
        taskStore.Complete(taskId, "cancelled", "{\"success\":false,\"error\":\"cancelled\"}");
    }
    catch (Exception exception)
    {
        taskStore.Complete(taskId, "failed", JsonSerializer.Serialize(new { success = false, error = exception.Message }));
    }
}

static async Task RunCloudRegisterAsync(AgentTaskStore taskStore, string taskId, ProvisionAgentRequest request)
{
    taskStore.Update(taskId, status: "running", message: "Bulut kayit gorevi baslatildi.");
    taskStore.SetStages(taskId,
    [
        new AgentTaskStage("Giris", "Bekliyor", string.Empty),
        new AgentTaskStage("Hik-Connect Durumu", "Bekliyor", string.Empty),
        new AgentTaskStage("Cihaz Eklendi", "Bekliyor", string.Empty),
        new AgentTaskStage("Kanal Alana Aktarildi", "Bekliyor", string.Empty),
        new AgentTaskStage("Tamamlandi", "Bekliyor", string.Empty)
    ]);

    try
    {
        var token = taskStore.GetCancellation(taskId).Token;
        var options = new AgentCameraConnectionOptions(
            request.CameraAddress.Trim(),
            string.IsNullOrWhiteSpace(request.UserName) ? "admin" : request.UserName.Trim(),
            request.Password);

        using var client = new AgentCameraIsapiClient(options);
        taskStore.UpdateStage(taskId, "Giris", "Calisiyor", "deviceInfo okunuyor.");
        var deviceInfo = await client.GetDeviceInfoAsync(token).ConfigureAwait(false);
        var ezvizStatus = await client.GetEzvizStatusAsync(token).ConfigureAwait(false);
        taskStore.UpdateStage(taskId, "Giris", "Tamam", $"Model={deviceInfo.Model}, KisaSeri={deviceInfo.ShortSerial}");

        taskStore.UpdateStage(taskId, "Hik-Connect Durumu", "Calisiyor", "EZVIZ registerStatus kontrol ediliyor.");
        if (ezvizStatus.RegisterStatus != true)
        {
            throw new InvalidOperationException("Kamera henuz Hik-Connect tarafinda online degil. Once yerel ayarlari uygula ve registerStatus=true oldugunu dogrula.");
        }

        taskStore.UpdateStage(taskId, "Hik-Connect Durumu", "Tamam", "registerStatus=true.");

        var verificationCode = string.IsNullOrWhiteSpace(request.VerificationCode)
            ? throw new InvalidOperationException("Buluta ekleme icin verification code gerekli. Kameradaki mevcut verification code'u gir.")
            : request.VerificationCode.Trim();
        var alias = string.IsNullOrWhiteSpace(request.Alias)
            ? $"CAM-{deviceInfo.ShortSerial}"
            : request.Alias.Trim();

        taskStore.UpdateStage(taskId, "Cihaz Eklendi", "Calisiyor", "Hik-Connect Team backend istegi gonderiliyor.");
        using var backendClient = new AgentTeamBackendClient(request.BackendUrl);
        await backendClient.CheckHealthAsync(token).ConfigureAwait(false);
        var backendResult = await backendClient.AddDeviceAsync(
            new AgentBackendAddDeviceRequest(
                deviceInfo.ShortSerial,
                verificationCode,
                alias,
                request.AreaName ?? string.Empty),
            token).ConfigureAwait(false);

        if (!backendResult.Success)
        {
            throw new InvalidOperationException(backendResult.Message);
        }

        taskStore.UpdateStage(taskId, "Cihaz Eklendi", "Tamam", backendResult.DeviceStatusMessage);
        taskStore.UpdateStage(taskId, "Kanal Alana Aktarildi", "Tamam", backendResult.ChannelStatusMessage);
        taskStore.UpdateStage(taskId, "Tamamlandi", "Tamam", "Bulut kaydi tamamlandi.");

        taskStore.Complete(taskId, "completed", JsonSerializer.Serialize(new
        {
            success = true,
            mode = "cloudRegister",
            device = new
            {
                deviceInfo.Model,
                deviceInfo.SerialNumber,
                deviceInfo.ShortSerial,
                deviceInfo.SubSerialNumber,
                deviceInfo.FirmwareVersion,
                deviceInfo.MacAddress,
                CurrentIpAddress = options.CameraAddress
            },
            ezviz = ezvizStatus,
            backend = new
            {
                backendResult.DeviceId,
                backendResult.AreaId,
                backendResult.AreaName,
                backendResult.Alias,
                backendResult.DeviceStatusMessage,
                backendResult.ChannelStatusMessage
            }
        }));
    }
    catch (OperationCanceledException)
    {
        taskStore.Complete(taskId, "cancelled", "{\"success\":false,\"error\":\"cancelled\"}");
    }
    catch (Exception exception)
    {
        taskStore.Complete(taskId, "failed", JsonSerializer.Serialize(new { success = false, error = exception.Message }));
    }
}

static async Task RunConnectAsync(AgentTaskStore taskStore, string taskId, ProvisionAgentRequest request)
{
    taskStore.Update(taskId, status: "running", message: "Aktive et ve baglan akisi baslatildi.");
    taskStore.SetStages(taskId,
    [
        new AgentTaskStage("Erisim", "Bekliyor", string.Empty),
        new AgentTaskStage("Aktivasyon", "Bekliyor", string.Empty),
        new AgentTaskStage("Giris", "Bekliyor", string.Empty)
    ]);

    try
    {
        var token = taskStore.GetCancellation(taskId).Token;
        var options = new AgentCameraConnectionOptions(
            request.CameraAddress.Trim(),
            string.IsNullOrWhiteSpace(request.UserName) ? "admin" : request.UserName.Trim(),
            request.Password);

        var currentIpAddress = options.CameraAddress;
        var activationRequired = false;
        taskStore.UpdateStage(taskId, "Erisim", "Calisiyor", "Kamera erisimi ve aktivasyon durumu kontrol ediliyor.");

        using var client = new AgentCameraIsapiClient(options);
        try
        {
            var activateStatus = await client.GetActivateStatusAsync(token).ConfigureAwait(false);
            activationRequired = activateStatus.IsInactive;
        }
        catch (AgentCameraIsapiException exception) when (
            exception.StatusCode == HttpStatusCode.Forbidden &&
            string.Equals(exception.SubStatusCode, "notActivated", StringComparison.OrdinalIgnoreCase))
        {
            activationRequired = true;
        }
        catch (AgentCameraIsapiException exception) when (LooksLikeAlreadyActiveActivateStatusFailure(exception))
        {
            activationRequired = false;
        }

        taskStore.UpdateStage(taskId, "Erisim", "Tamam", activationRequired ? "Kamera inactive bulundu." : "Kamera aktif.");

        if (activationRequired)
        {
            taskStore.UpdateStage(taskId, "Aktivasyon", "Calisiyor", "HCNetSDK ile ilk aktivasyon yapiliyor.");
            using var session = new HikSdk.Interop.HikActivationSession();
            session.Initialize(Path.Combine(AppContext.BaseDirectory, "sdk-logs"));
            var activationResult = session.ActivateDevice(currentIpAddress, request.SdkPort, options.Password);
            if (!activationResult.Success)
            {
                throw new InvalidOperationException($"NET_DVR_ActivateDevice basarisiz. NET_DVR_GetLastError={activationResult.ErrorCode}, Message={activationResult.ErrorMessage}");
            }

            taskStore.UpdateStage(taskId, "Aktivasyon", "Tamam", "Kamera aktive edildi.");
        }
        else
        {
            taskStore.UpdateStage(taskId, "Aktivasyon", "Atlandi", "Kamera zaten aktif.");
        }

        taskStore.UpdateStage(taskId, "Giris", "Calisiyor", "deviceInfo okunuyor ve SDK login dogrulaniyor.");
        var deviceInfo = activationRequired
            ? await client.WaitForDeviceInfoAsync(TimeSpan.FromSeconds(90), TimeSpan.FromSeconds(3), token).ConfigureAwait(false)
            : await client.GetDeviceInfoAsync(token).ConfigureAwait(false);

        using (var session = new HikSdk.Interop.HikActivationSession())
        {
            session.Initialize(Path.Combine(AppContext.BaseDirectory, "sdk-logs"));
            var loginResult = session.Login(currentIpAddress, request.SdkPort, options.UserName, options.Password);
            if (!loginResult.Success)
            {
                throw new InvalidOperationException($"NET_DVR_Login_V40 basarisiz. NET_DVR_GetLastError={loginResult.ErrorCode}, Message={loginResult.ErrorMessage}");
            }
        }

        var networkInterfaces = await client.GetNetworkInterfacesAsync(token).ConfigureAwait(false);
        AgentEzvizStatusInfo? ezvizStatus = null;
        try
        {
            ezvizStatus = await client.GetEzvizStatusAsync(token).ConfigureAwait(false);
        }
        catch
        {
        }

        taskStore.UpdateStage(taskId, "Giris", "Tamam", $"Model={deviceInfo.Model}, KisaSeri={deviceInfo.ShortSerial}");
        taskStore.Complete(taskId, "completed", JsonSerializer.Serialize(new
        {
            success = true,
            mode = "connect",
            device = new
            {
                deviceInfo.Model,
                deviceInfo.SerialNumber,
                deviceInfo.ShortSerial,
                deviceInfo.SubSerialNumber,
                deviceInfo.FirmwareVersion,
                deviceInfo.MacAddress,
                CurrentIpAddress = currentIpAddress
            },
            network = networkInterfaces,
            ezviz = ezvizStatus
        }));
    }
    catch (OperationCanceledException)
    {
        taskStore.Complete(taskId, "cancelled", "{\"success\":false,\"error\":\"cancelled\"}");
    }
    catch (Exception exception)
    {
        taskStore.Complete(taskId, "failed", JsonSerializer.Serialize(new { success = false, error = exception.Message }));
    }
}

static bool LooksLikeAlreadyActiveActivateStatusFailure(AgentCameraIsapiException exception)
{
    if (exception.StatusCode != HttpStatusCode.Forbidden)
    {
        return false;
    }

    if (string.Equals(exception.SubStatusCode, "notActivated", StringComparison.OrdinalIgnoreCase))
    {
        return false;
    }

    return exception.ResponseBody.Contains("Invalid Operation", StringComparison.OrdinalIgnoreCase) ||
           exception.ResponseBody.Contains("invalidOperation", StringComparison.OrdinalIgnoreCase) ||
           exception.ResponseBody.Contains("invalid operation", StringComparison.OrdinalIgnoreCase);
}

internal static class CliRunner
{
    public static async Task<CliRunResult> RunAsync(IReadOnlyList<string> args, CancellationToken cancellationToken)
    {
        var cliPath = ResolveCliPath();
        var argumentText = string.Join(" ", args.Select(Quote));
        var startInfo = new ProcessStartInfo
        {
            FileName = "dotnet",
            Arguments = $"{Quote(cliPath)} {argumentText}",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        using var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        process.Start();

        using var registration = cancellationToken.Register(() =>
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
            }
            catch
            {
            }
        });

        var stdOut = await process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stdErr = await process.StandardError.ReadToEndAsync(cancellationToken);
        await process.WaitForExitAsync(cancellationToken);

        var payload = string.IsNullOrWhiteSpace(stdOut)
            ? JsonSerializer.Serialize(new { success = false, error = stdErr.Trim() })
            : stdOut.Trim();

        return new CliRunResult(process.ExitCode, payload, stdErr.Trim());
    }

    public static object GetCliStatus()
    {
        try
        {
            var cliPath = ResolveCliPath();
            var sdkDirectory = Path.GetDirectoryName(cliPath) ?? string.Empty;
            var sdkDllPath = Path.Combine(sdkDirectory, "HCNetSDK.dll");
            return new
            {
                found = true,
                path = cliPath,
                sdkDllFound = File.Exists(sdkDllPath),
                sdkDllPath
            };
        }
        catch (Exception exception)
        {
            return new
            {
                found = false,
                error = exception.Message
            };
        }
    }

    public static string ResolveCliPath()
    {
        var candidatePaths = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "tools", "HikSdk.ProvisioningCli", "HikSdk.ProvisioningCli.dll"),
            Path.Combine(AppContext.BaseDirectory, "HikSdk.ProvisioningCli.dll"),
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "HikSdk.ProvisioningCli", "bin", "x64", "Release", "net9.0-windows", "HikSdk.ProvisioningCli.dll")),
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "HikSdk.ProvisioningCli.dll"))
        };

        return candidatePaths.FirstOrDefault(File.Exists)
            ?? throw new FileNotFoundException("HikSdk.ProvisioningCli.dll bulunamadi.", candidatePaths[0]);
    }

    private static string Quote(string value) => value.Contains(' ') ? $"\"{value}\"" : value;
}

internal sealed class AgentTaskStore
{
    private readonly object _sync = new();
    private readonly Dictionary<string, AgentTaskState> _tasks = new(StringComparer.OrdinalIgnoreCase);

    public AgentTaskState Create(string taskKind, ProvisionAgentRequest request)
    {
        var task = new AgentTaskState
        {
            TaskId = Guid.NewGuid().ToString("n"),
            TaskKind = taskKind,
            Status = "queued",
            CreatedAtUtc = DateTimeOffset.UtcNow,
            UpdatedAtUtc = DateTimeOffset.UtcNow,
            CameraAddress = request.CameraAddress,
            Message = "Siraya alindi.",
            Cancellation = new CancellationTokenSource()
        };

        lock (_sync)
        {
            _tasks[task.TaskId] = task;
        }

        return task;
    }

    public bool TryGet(string taskId, out AgentTaskState? task)
    {
        lock (_sync)
        {
            return _tasks.TryGetValue(taskId, out task);
        }
    }

    public void Update(string taskId, string status, string message)
    {
        lock (_sync)
        {
            if (_tasks.TryGetValue(taskId, out var task))
            {
                task.Status = status;
                task.Message = message;
                task.UpdatedAtUtc = DateTimeOffset.UtcNow;
            }
        }
    }

    public void Complete(string taskId, string status, string resultJson)
    {
        lock (_sync)
        {
            if (_tasks.TryGetValue(taskId, out var task))
            {
                task.Status = status;
                task.ResultJson = resultJson;
                task.Message = status;
                task.UpdatedAtUtc = DateTimeOffset.UtcNow;
                task.Cancellation.Dispose();
            }
        }
    }

    public CancellationTokenSource GetCancellation(string taskId)
    {
        lock (_sync)
        {
            return _tasks[taskId].Cancellation;
        }
    }

    public bool TryCancel(string taskId)
    {
        lock (_sync)
        {
            if (!_tasks.TryGetValue(taskId, out var task))
            {
                return false;
            }

            task.Cancellation.Cancel();
            task.Status = "cancelled";
            task.Message = "Iptal istendi.";
            task.UpdatedAtUtc = DateTimeOffset.UtcNow;
            return true;
        }
    }

    public void SetStages(string taskId, IEnumerable<AgentTaskStage> stages)
    {
        lock (_sync)
        {
            if (_tasks.TryGetValue(taskId, out var task))
            {
                task.Stages = stages.Select(stage => new AgentTaskStage(stage.Name, stage.Status, stage.Detail)).ToList();
                task.UpdatedAtUtc = DateTimeOffset.UtcNow;
            }
        }
    }

    public void UpdateStage(string taskId, string name, string status, string detail)
    {
        lock (_sync)
        {
            if (!_tasks.TryGetValue(taskId, out var task))
            {
                return;
            }

            var stage = task.Stages.FirstOrDefault(item => string.Equals(item.Name, name, StringComparison.OrdinalIgnoreCase));
            if (stage is null)
            {
                task.Stages.Add(new AgentTaskStage(name, status, detail));
            }
            else
            {
                stage.Status = status;
                stage.Detail = detail;
            }

            task.UpdatedAtUtc = DateTimeOffset.UtcNow;
        }
    }

    public AgentTaskResponse ToResponse(AgentTaskState task)
    {
        lock (_sync)
        {
            return new AgentTaskResponse(
                task.TaskId,
                task.TaskKind,
                task.Status,
                task.CreatedAtUtc,
                task.UpdatedAtUtc,
                task.CameraAddress,
                task.Message,
                task.ResultJson,
                task.Stages.Select(stage => new AgentTaskStage(stage.Name, stage.Status, stage.Detail)).ToList());
        }
    }
}

internal sealed class AgentTaskState
{
    public string TaskId { get; set; } = string.Empty;
    public string TaskKind { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public DateTimeOffset CreatedAtUtc { get; set; }
    public DateTimeOffset UpdatedAtUtc { get; set; }
    public string CameraAddress { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
    public string ResultJson { get; set; } = string.Empty;
    public List<AgentTaskStage> Stages { get; set; } = [];
    [JsonIgnore]
    public CancellationTokenSource Cancellation { get; set; } = new();
}

internal sealed class AgentTaskStage
{
    public AgentTaskStage(string name, string status, string detail)
    {
        Name = name;
        Status = status;
        Detail = detail;
    }

    public string Name { get; set; }
    public string Status { get; set; }
    public string Detail { get; set; }
}

internal sealed record AgentTaskResponse(
    string TaskId,
    string TaskKind,
    string Status,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset UpdatedAtUtc,
    string CameraAddress,
    string Message,
    string ResultJson,
    IReadOnlyList<AgentTaskStage> Stages);

internal sealed record DiscoverAgentRequest(int? ScanSeconds, int? Concurrency, string? SubnetPrefix);

internal sealed record ProvisionAgentRequest(
    string CameraAddress,
    string UserName,
    string Password,
    string BackendUrl,
    string? AreaName,
    string? Alias,
    string? GatewayOverride,
    string? PrimaryDns,
    string? SecondaryDns,
    string? VerificationCode,
    bool EnableDhcp,
    ushort SdkPort = 8000);

internal sealed record CliRunResult(int ExitCode, string OutputJson, string ErrorText);
