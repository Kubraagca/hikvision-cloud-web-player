using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Caching.Memory;
using HikProvisioning.Web.Services;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory,
    WebRootPath = Path.Combine(AppContext.BaseDirectory, "wwwroot")
});
var dataProtectionDirectory = Path.Combine(AppContext.BaseDirectory, "data-protection-keys");
Directory.CreateDirectory(dataProtectionDirectory);

builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole();
builder.Services.AddRazorPages();
builder.Services.AddMemoryCache();
builder.Services
    .AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo(dataProtectionDirectory))
    .SetApplicationName("HikProvisioning.Web");
builder.Services.AddHttpClient<HikConnectGatewayClient>(client =>
{
    client.Timeout = TimeSpan.FromSeconds(30);
    client.DefaultRequestHeaders.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("application/json"));
});
builder.Services.AddSingleton<HikConnectGatewayService>();
builder.Services.AddSingleton<ProvisioningTaskStore>();
builder.Services.AddSingleton<CameraProvisioningService>();

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseStaticFiles();
app.UseRouting();

app.MapGet("/api/health", async (HikConnectGatewayService gatewayService, CancellationToken cancellationToken) =>
{
    try
    {
        var status = await gatewayService.GetHealthAsync(cancellationToken);
        return Results.Ok(new
        {
            ok = status.Ok,
            configured = true,
            initialServer = status.InitialServer,
            areaDomain = status.AreaDomain,
            expiresAt = status.ExpiresAt
        });
    }
    catch (Exception exception)
    {
        return Results.Ok(new
        {
            ok = false,
            configured = true,
            error = exception.Message
        });
    }
});

app.MapGet("/api/cameras", async (HikConnectGatewayService gatewayService, CancellationToken cancellationToken) =>
{
    try
    {
        var cameras = await gatewayService.GetCamerasAsync(cancellationToken);
        return Results.Ok(new { cameras });
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { error = exception.Message });
    }
});

app.MapGet("/api/stream", async (
    string resourceId,
    string deviceSerial,
    int? protocol,
    int? quality,
    string? code,
    HikConnectGatewayService gatewayService,
    IMemoryCache cache,
    CancellationToken cancellationToken) =>
{
    try
    {
        var cacheKey = $"stream:{resourceId}:{deviceSerial}:{protocol ?? 2}:{quality ?? 1}";
        if (!cache.TryGetValue(cacheKey, out StreamAddressResult? stream))
        {
            stream = await gatewayService.GetStreamAddressAsync(
                resourceId,
                deviceSerial,
                protocol ?? 2,
                quality ?? 1,
                code,
                cancellationToken);
            cache.Set(cacheKey, stream, stream.ExpiresAt);
        }

        if (stream is null)
        {
            throw new InvalidOperationException("Stream address uretilmedi.");
        }

        return Results.Ok(new
        {
            url = stream.Url,
            protocol = stream.Protocol,
            quality = stream.Quality,
            expireTime = stream.ExpiresAt,
            resolvedPath = stream.ResolvedPath
        });
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { error = exception.Message });
    }
});

app.MapGet("/api/hls/manifest", async (
    string resourceId,
    string deviceSerial,
    int? quality,
    HttpContext httpContext,
    HikConnectGatewayService gatewayService,
    CancellationToken cancellationToken) =>
{
    try
    {
        var stream = await gatewayService.GetStreamAddressAsync(resourceId, deviceSerial, 2, quality ?? 1, null, cancellationToken);
        using var client = new HttpClient();
        var upstreamResponse = await client.GetAsync(stream.Url, cancellationToken);
        var manifest = await upstreamResponse.Content.ReadAsStringAsync(cancellationToken);
        if (!upstreamResponse.IsSuccessStatusCode)
        {
            return Results.BadRequest(new { error = "Upstream HLS manifest alinamadi.", status = (int)upstreamResponse.StatusCode });
        }

        var rewritten = RewriteManifest(manifest, stream.Url, resourceId, deviceSerial, quality ?? 1);
        return Results.Text(rewritten, "application/vnd.apple.mpegurl");
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { error = exception.Message });
    }
});

app.MapGet("/api/hls/chunk", async (string target, CancellationToken cancellationToken) =>
{
    try
    {
        using var client = new HttpClient();
        using var upstreamResponse = await client.GetAsync(target, cancellationToken);
        if (!upstreamResponse.IsSuccessStatusCode)
        {
            return Results.BadRequest(new { error = "Upstream HLS parcasi alinamadi.", status = (int)upstreamResponse.StatusCode });
        }

        var contentType = upstreamResponse.Content.Headers.ContentType?.ToString() ?? "application/octet-stream";
        var bytes = await upstreamResponse.Content.ReadAsByteArrayAsync(cancellationToken);
        return Results.Bytes(bytes, contentType);
    }
    catch (Exception exception)
    {
        return Results.BadRequest(new { error = exception.Message });
    }
});

app.MapPost("/api/provision/start", (
    ProvisioningRequest request,
    CameraProvisioningService provisioningService,
    CancellationToken cancellationToken) =>
{
    if (string.IsNullOrWhiteSpace(request.CameraAddress))
    {
        return Results.BadRequest(new { error = "CameraAddress zorunlu." });
    }

    if (string.IsNullOrWhiteSpace(request.Password))
    {
        return Results.BadRequest(new { error = "Password zorunlu." });
    }

    var state = provisioningService.StartProvisioning(request, cancellationToken);
    return Results.Accepted($"/api/provision/tasks/{state.TaskId}", new { taskId = state.TaskId });
});

app.MapGet("/api/provision/tasks/{taskId}", (string taskId, ProvisioningTaskStore taskStore) =>
{
    if (!taskStore.TryGet(taskId, out var state) || state is null)
    {
        return Results.NotFound(new { error = "Task bulunamadi." });
    }

    return Results.Ok(new
    {
        taskId = state.TaskId,
        status = state.Status,
        createdAt = state.CreatedAtUtc,
        updatedAt = state.UpdatedAtUtc,
        stages = state.Stages,
        result = state.Result,
        error = state.Error
    });
});

app.MapRazorPages();
app.Run();

static string RewriteManifest(string content, string manifestUrl, string resourceId, string deviceSerial, int quality)
{
    var lines = content.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
    return string.Join(
        "\n",
        lines.Select(line =>
        {
            var trimmed = line.Trim();
            if (string.IsNullOrWhiteSpace(trimmed) || trimmed.StartsWith('#'))
            {
                if (trimmed.StartsWith("#EXT-X-KEY") && trimmed.Contains("URI=\"", StringComparison.Ordinal))
                {
                    return RegexPatterns.KeyUri.Replace(
                        line,
                        match =>
                        {
                            var absolute = new Uri(new Uri(manifestUrl), match.Groups[1].Value).ToString();
                            return $"URI=\"/api/hls/chunk?target={Uri.EscapeDataString(absolute)}&resourceId={Uri.EscapeDataString(resourceId)}&deviceSerial={Uri.EscapeDataString(deviceSerial)}&quality={quality}\"";
                        });
                }

                return line;
            }

            var absoluteChunk = new Uri(new Uri(manifestUrl), trimmed).ToString();
            return $"/api/hls/chunk?target={Uri.EscapeDataString(absoluteChunk)}&resourceId={Uri.EscapeDataString(resourceId)}&deviceSerial={Uri.EscapeDataString(deviceSerial)}&quality={quality}";
        }));
}

static class RegexPatterns
{
    public static readonly System.Text.RegularExpressions.Regex KeyUri =
        new("URI=\"([^\"]+)\"", System.Text.RegularExpressions.RegexOptions.Compiled);
}
