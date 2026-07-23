using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

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

app.MapPost("/agent/discover", async (DiscoverAgentRequest? request, CancellationToken cancellationToken) =>
{
    var args = new List<string>
    {
        "discover",
        "--scanSeconds", (request?.ScanSeconds ?? 12).ToString(),
        "--concurrency", (request?.Concurrency ?? 32).ToString()
    };

    if (!string.IsNullOrWhiteSpace(request?.SubnetPrefix))
    {
        args.Add("--subnetPrefix");
        args.Add(request.SubnetPrefix.Trim());
    }

    var result = await CliRunner.RunAsync(args, cancellationToken);
    return Results.Content(result.OutputJson, "application/json");
});

app.MapPost("/agent/provision/start", (ProvisionAgentRequest request, AgentTaskStore taskStore) =>
{
    var task = taskStore.Create(request);
    _ = Task.Run(() => RunProvisionAsync(taskStore, task.TaskId, request));
    return Results.Accepted($"/agent/tasks/{task.TaskId}", new { taskId = task.TaskId });
});

app.MapGet("/agent/tasks/{taskId}", (string taskId, AgentTaskStore taskStore) =>
{
    return taskStore.TryGet(taskId, out var task)
        ? Results.Ok(task)
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
    taskStore.Update(taskId, status: "running", message: "Yerel provisioning gorevi baslatildi.");

    try
    {
        using var cts = taskStore.GetCancellation(taskId);
        var args = new List<string>
        {
            "provision",
            "--ip", request.CameraAddress,
            "--userName", request.UserName,
            "--password", request.Password,
            "--backendUrl", request.BackendUrl,
            "--gateway", request.GatewayOverride ?? string.Empty,
            "--dns1", request.PrimaryDns ?? "8.8.8.8",
            "--dns2", request.SecondaryDns ?? "1.1.1.1",
            "--areaName", request.AreaName ?? string.Empty,
            "--alias", request.Alias ?? string.Empty,
            "--verificationCode", request.VerificationCode ?? string.Empty,
            "--sdkPort", request.SdkPort.ToString(),
            "--enableDhcp", request.EnableDhcp ? "true" : "false"
        };

        var result = await CliRunner.RunAsync(args, cts.Token);
        taskStore.Complete(taskId, result.ExitCode == 0 ? "completed" : "failed", result.OutputJson);
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

    public AgentTaskState Create(ProvisionAgentRequest request)
    {
        var task = new AgentTaskState
        {
            TaskId = Guid.NewGuid().ToString("n"),
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
}

internal sealed class AgentTaskState
{
    public string TaskId { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public DateTimeOffset CreatedAtUtc { get; set; }
    public DateTimeOffset UpdatedAtUtc { get; set; }
    public string CameraAddress { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
    public string ResultJson { get; set; } = string.Empty;
    public CancellationTokenSource Cancellation { get; set; } = new();
}

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
