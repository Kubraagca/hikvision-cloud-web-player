using System.Net;
using System.IO;
using System.Windows;
using HikSdk.Interop;

namespace HikSdk.SadpWpf;

public partial class MainWindow : Window
{
    private readonly ProvisioningRecordStore _recordStore = new();
    private CancellationTokenSource? _operationCts;

    public MainWindow()
    {
        InitializeComponent();
        DataContext = new MainWindowViewModel();
        InitializeStages();
    }

    private MainWindowViewModel ViewModel => (MainWindowViewModel)DataContext;

    private async void FullSetupButton_Click(object sender, RoutedEventArgs e)
    {
        await RunBusyOperationAsync("Baştan sona kurulum baslatiliyor.", RunFullSetupAsync);
    }

    private void CancelButton_Click(object sender, RoutedEventArgs e)
    {
        _operationCts?.Cancel();
        ViewModel.StatusText = "Iptal istendi.";
    }

    private async void ConnectButton_Click(object sender, RoutedEventArgs e)
    {
        await RunBusyOperationAsync("Aktivasyon ve ilk baglanti akisi baslatiliyor.", RunActivationAndReadAsync);
    }

    private async void LoadNetworkButton_Click(object sender, RoutedEventArgs e)
    {
        await RunBusyOperationAsync(
            "Ag bilgileri okunuyor.",
            async client =>
            {
                var info = await client.GetDeviceInfoAsync(CurrentToken);
                var interfaces = await client.GetNetworkInterfacesAsync(CurrentToken);
                var ezvizStatus = await client.GetEzvizStatusAsync(CurrentToken);
                ApplyDeviceInfo(info);
                ApplyNetworkInterfaces(interfaces);
                ApplyEzvizStatus(ezvizStatus);
                ViewModel.StatusText = $"Ag bilgileri guncellendi. Arayuz sayisi: {interfaces.Count}.";
                ViewModel.ErrorText = "Hata yok.";
            });
    }

    private async void RefreshEzvizButton_Click(object sender, RoutedEventArgs e)
    {
        await RunBusyOperationAsync(
            "EZVIZ durumu sorgulaniyor.",
            async client =>
            {
                var ezvizStatus = await client.GetEzvizStatusAsync(CurrentToken);
                ApplyEzvizStatus(ezvizStatus);
                ViewModel.StatusText = "EZVIZ durumu guncellendi.";
                ViewModel.ErrorText = "Hata yok.";
            });
    }

    private void GenerateCodeButton_Click(object sender, RoutedEventArgs e)
    {
        ViewModel.VerificationCode = IsapiClient.CreateVerificationCode(12);
        ViewModel.StatusText = "Yeni verification code uretildi.";
        ViewModel.ErrorText = "Kod loglanmadi; sadece ekranda gosteriliyor.";
    }

    private async void EnableEzvizButton_Click(object sender, RoutedEventArgs e)
    {
        await RunBusyOperationAsync(
            "Hik-Connect etkinlestirme istegi gonderiliyor.",
            async client =>
            {
                var verificationCode = EnsureVerificationCode();
                var result = await client.EnableEzvizAsync(
                    verificationCode,
                    pollInterval: TimeSpan.FromSeconds(5),
                    timeout: TimeSpan.FromMinutes(2),
                    cancellationToken: CurrentToken);

                ApplyEzvizStatus(result.FinalStatus);
                ViewModel.StatusText = result.TimedOut
                    ? "EZVIZ durumu iki dakika icinde online olmadi. Gateway veya DNS baglantisini kontrol edin."
                    : $"EZVIZ online oldu. Poll sayisi: {result.PollCount}.";
                ViewModel.ErrorText = "Hata yok.";
            });
    }

    protected override void OnClosed(EventArgs e)
    {
        _operationCts?.Cancel();
        _operationCts?.Dispose();
        base.OnClosed(e);
    }

    private CancellationToken CurrentToken => _operationCts?.Token ?? CancellationToken.None;

    private async Task RunBusyOperationAsync(string startingStatus, Func<IsapiClient, Task> action)
    {
        if (ViewModel.IsBusy)
        {
            return;
        }

        ResetStages();
        _operationCts = new CancellationTokenSource();

        try
        {
            ViewModel.IsBusy = true;
            ViewModel.StatusText = startingStatus;
            ViewModel.ErrorText = "Islem devam ediyor.";

            var options = CreateConnectionOptions();
            using var client = new IsapiClient(options);
            await action(client);
        }
        catch (OperationCanceledException)
        {
            ViewModel.StatusText = "Islem kullanici tarafindan iptal edildi.";
            ViewModel.ErrorText = "Iptal edildi.";
        }
        catch (Exception exception)
        {
            ViewModel.ErrorText = SanitizeError(exception.Message);
            ViewModel.StatusText = "Islem basarisiz oldu.";
        }
        finally
        {
            ViewModel.IsBusy = false;
            _operationCts.Dispose();
            _operationCts = null;
        }
    }

    private async Task RunActivationAndReadAsync(IsapiClient client)
    {
        var options = CreateConnectionOptions();
        var activation = await EnsureCameraReadyAsync(client, options);
        ApplyDeviceInfo(activation.DeviceInfo);
        ViewModel.CurrentIpAddress = activation.CurrentIpAddress;
        ViewModel.ErrorText = "Hata yok.";
        ViewModel.StatusText = activation.ActivationPerformed
            ? "Kamera aktive edildi ve deviceInfo okundu."
            : "Kamera zaten aktifti ve deviceInfo okundu.";
    }

    private async Task RunFullSetupAsync(IsapiClient client)
    {
        var options = CreateConnectionOptions();
        var setupContext = await EnsureCameraReadyAsync(client, options);
        var activeClient = client;
        IsapiClient? updatedClient = null;

        var networkInterfaces = await ExecuteStageAsync(
            "Ag Ayari",
            "Ag bilgileri okunuyor ve gateway/DNS guncelleniyor.",
            async () =>
            {
                var current = await activeClient.GetNetworkInterfacesAsync(CurrentToken);
                ApplyNetworkInterfaces(current);
                return await activeClient.UpdateGatewayDnsAsync(
                    ViewModel.GatewayOverride,
                    dns1: "8.8.8.8",
                    dns2: "1.1.1.1",
                    enableDhcp: ViewModel.EnableDhcp,
                    cancellationToken: CurrentToken);
            });

        ApplyNetworkInterfaces(networkInterfaces);

        if (ViewModel.EnableDhcp)
        {
            var foundIp = await ExecuteStageAsync(
                "Ag Ayari",
                "DHCP sonrasi yeni IP adresi bulunuyor.",
                async () => await activeClient.FindCameraIpInSubnetAsync(
                    setupContext.CurrentIpAddress,
                    options.UserName,
                    options.Password,
                    setupContext.DeviceInfo.ShortSerial,
                    setupContext.DeviceInfo.MacAddress,
                    CurrentToken));

            if (!string.IsNullOrWhiteSpace(foundIp))
            {
                ViewModel.CameraAddress = foundIp;
                ViewModel.CurrentIpAddress = foundIp;
                options = options with { CameraAddress = foundIp };
                updatedClient?.Dispose();
                updatedClient = new IsapiClient(options);
                activeClient = updatedClient;
                networkInterfaces = await activeClient.GetNetworkInterfacesAsync(CurrentToken);
                ApplyNetworkInterfaces(networkInterfaces);
            }
        }

        var verificationCode = EnsureVerificationCode();
        var ezvizResult = await ExecuteStageAsync(
            "Hik-Connect Online",
            "Kamera EZVIZ/Hik-Connect tarafinda online bekleniyor.",
            async () => await activeClient.EnableEzvizAsync(
                verificationCode,
                pollInterval: TimeSpan.FromSeconds(5),
                timeout: TimeSpan.FromMinutes(2),
                cancellationToken: CurrentToken));

        ApplyEzvizStatus(ezvizResult.FinalStatus);
        if (ezvizResult.TimedOut)
        {
            throw new InvalidOperationException("registerStatus iki dakika icinde true olmadi. Gateway ve DNS baglantisini kontrol edin.");
        }

        var alias = $"CAM-{setupContext.DeviceInfo.ShortSerial}";
        var backendResult = await ExecuteStageAsync(
            "Cihaz Eklendi",
            "Hik-Connect for Teams backend istegi gonderiliyor.",
            async () =>
            {
                using var backendClient = new TeamBackendClient(ViewModel.BackendBaseUrl);
                return await backendClient.AddDeviceAsync(
                    new BackendAddDeviceRequest(
                        setupContext.DeviceInfo.ShortSerial,
                        verificationCode,
                        alias,
                        ViewModel.AreaName),
                    CurrentToken);
            });

        if (!backendResult.Success)
        {
            throw new InvalidOperationException(backendResult.Message);
        }

        ViewModel.DeviceId = backendResult.DeviceId;
        ViewModel.AreaId = backendResult.AreaId;
        CompleteStage("Cihaz Eklendi", "Tamam", backendResult.DeviceStatusMessage);
        CompleteStage("Kanal Alana Aktarildi", "Tamam", backendResult.ChannelStatusMessage);

        await _recordStore.SaveAsync(
            new ProvisionedCameraRecord(
                backendResult.DeviceId,
                setupContext.DeviceInfo.ShortSerial,
                setupContext.DeviceInfo.MacAddress,
                ViewModel.CurrentIpAddress,
                backendResult.Alias,
                DateTimeOffset.UtcNow),
            CurrentToken);

        CompleteStage("Tamamlandi", "Basarili", $"deviceId={backendResult.DeviceId}");
        ViewModel.StatusText = "Baştan sona kurulum tamamlandi.";
        ViewModel.ErrorText = "Hata yok.";
        updatedClient?.Dispose();
    }

    private async Task<ActivationContext> EnsureCameraReadyAsync(IsapiClient client, CameraConnectionOptions options)
    {
        var sdkAddress = ExtractSdkAddress(options.CameraAddress);
        var activationPerformed = false;

        if (options.Password.Length > HikConstants.PASSWD_LEN)
        {
            throw new InvalidOperationException($"Aktivasyon parolasi HCNetSDK.h icindeki PASSWD_LEN nedeniyle en fazla {HikConstants.PASSWD_LEN} karakter olabilir.");
        }

        await ExecuteStageAsync(
            "Erisim",
            "Kamera IP erisimi ve aktivasyon durumu kontrol ediliyor.",
            async () =>
            {
                try
                {
                    var activateStatus = await client.GetActivateStatusAsync(CurrentToken);
                    if (activateStatus.IsInactive)
                    {
                        activationPerformed = true;
                    }
                }
                catch (IsapiRequestException exception) when (
                    exception.StatusCode == HttpStatusCode.Forbidden &&
                    string.Equals(exception.SubStatusCode, "notActivated", StringComparison.OrdinalIgnoreCase))
                {
                    activationPerformed = true;
                }
            });

        if (activationPerformed)
        {
            await ExecuteStageAsync(
                "Aktivasyon",
                "HCNetSDK ile ilk aktivasyon yapiliyor.",
                async () =>
                {
                    using var sdkSession = new HikActivationSession();
                    sdkSession.Initialize(Path.Combine(AppContext.BaseDirectory, "sdk-logs"));
                    var activationResult = sdkSession.ActivateDevice("192.168.1.64", 8000, options.Password);
                    if (!activationResult.Success)
                    {
                        throw new InvalidOperationException($"NET_DVR_ActivateDevice basarisiz. NET_DVR_GetLastError={activationResult.ErrorCode}, Message={activationResult.ErrorMessage}");
                    }
                    await Task.CompletedTask;
                });
        }
        else
        {
            CompleteStage("Aktivasyon", "Atlandi", "Kamera zaten aktif.");
        }

        var deviceInfo = await ExecuteStageAsync(
            "Giris",
            activationPerformed
                ? "Aktivasyon sonrasi camera deviceInfo bekleniyor."
                : "DeviceInfo okunuyor ve HCNetSDK login deneniyor.",
            async () =>
            {
                var info = activationPerformed
                    ? await client.WaitForDeviceInfoAsync(TimeSpan.FromSeconds(90), TimeSpan.FromSeconds(3), CurrentToken)
                    : await client.GetDeviceInfoAsync(CurrentToken);

                using var sdkSession = new HikActivationSession();
                sdkSession.Initialize(Path.Combine(AppContext.BaseDirectory, "sdk-logs"));
                var loginResult = sdkSession.Login(sdkAddress, 8000, options.UserName, options.Password);
                if (!loginResult.Success)
                {
                    throw new InvalidOperationException($"NET_DVR_Login_V40 basarisiz. NET_DVR_GetLastError={loginResult.ErrorCode}, Message={loginResult.ErrorMessage}");
                }

                return info;
            });

        ApplyDeviceInfo(deviceInfo);
        ViewModel.CurrentIpAddress = options.CameraAddress;
        return new ActivationContext(deviceInfo, options.CameraAddress, activationPerformed);
    }

    private string EnsureVerificationCode()
    {
        if (string.IsNullOrWhiteSpace(ViewModel.VerificationCode))
        {
            ViewModel.VerificationCode = IsapiClient.CreateVerificationCode(12);
        }

        return ViewModel.VerificationCode;
    }

    private CameraConnectionOptions CreateConnectionOptions()
    {
        var cameraAddress = ViewModel.CameraAddress.Trim();
        if (string.IsNullOrWhiteSpace(cameraAddress))
        {
            throw new InvalidOperationException("Kamera adresi bos birakilamaz.");
        }

        var userName = ViewModel.UserName.Trim();
        if (string.IsNullOrWhiteSpace(userName))
        {
            throw new InvalidOperationException("Kullanici adi bos birakilamaz.");
        }

        var password = PasswordInput.Password;
        if (string.IsNullOrWhiteSpace(password))
        {
            throw new InvalidOperationException("Parola bos birakilamaz.");
        }

        return new CameraConnectionOptions(cameraAddress, userName, password);
    }

    private static string ExtractSdkAddress(string cameraAddress)
    {
        var trimmed = cameraAddress.Trim();
        if (!trimmed.Contains("://", StringComparison.Ordinal))
        {
            return trimmed;
        }

        return Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)
            ? uri.Host
            : trimmed;
    }

    private void ApplyDeviceInfo(DeviceInfoModel deviceInfo)
    {
        ViewModel.Model = EmptyToPlaceholder(deviceInfo.Model);
        ViewModel.SerialNumber = EmptyToPlaceholder(deviceInfo.SerialNumber);
        ViewModel.ShortSerial = EmptyToPlaceholder(deviceInfo.ShortSerial);
        ViewModel.SubSerialNumber = EmptyToPlaceholder(deviceInfo.SubSerialNumber);
        ViewModel.FirmwareVersion = EmptyToPlaceholder(deviceInfo.FirmwareVersion);
        ViewModel.MacAddress = EmptyToPlaceholder(deviceInfo.MacAddress);
    }

    private void ApplyNetworkInterfaces(IReadOnlyList<NetworkInterfaceModel> networkInterfaces)
    {
        ViewModel.NetworkInterfaces.SyncFrom(networkInterfaces.Select(model => new NetworkInterfaceRow(model)));
        var firstIp = networkInterfaces.Select(item => item.IpAddress).FirstOrDefault(item => !string.IsNullOrWhiteSpace(item) && item != "-");
        if (!string.IsNullOrWhiteSpace(firstIp))
        {
            ViewModel.CurrentIpAddress = firstIp;
        }
    }

    private void ApplyEzvizStatus(EzvizStatusModel ezvizStatus)
    {
        ViewModel.EzvizEnabledText = ezvizStatus.Enabled switch
        {
            true => "true",
            false => "false",
            _ => "bilinmiyor"
        };

        ViewModel.RegisterStatusText = ezvizStatus.RegisterStatus switch
        {
            true => "true",
            false => "false",
            _ => "bilinmiyor"
        };
    }

    private void InitializeStages()
    {
        ViewModel.Stages.SyncFrom(
        [
            new SetupStageRow("Erisim"),
            new SetupStageRow("Aktivasyon"),
            new SetupStageRow("Giris"),
            new SetupStageRow("Ag Ayari"),
            new SetupStageRow("Hik-Connect Online"),
            new SetupStageRow("Cihaz Eklendi"),
            new SetupStageRow("Kanal Alana Aktarildi"),
            new SetupStageRow("Tamamlandi")
        ]);
    }

    private void ResetStages()
    {
        foreach (var stage in ViewModel.Stages)
        {
            stage.Status = "Bekliyor";
            stage.Detail = string.Empty;
        }
    }

    private SetupStageRow Stage(string name) =>
        ViewModel.Stages.First(item => item.Name == name);

    private async Task ExecuteStageAsync(string name, string detail, Func<Task> action)
    {
        var stage = Stage(name);
        stage.Status = "Calisiyor";
        stage.Detail = detail;
        ViewModel.StatusText = detail;

        try
        {
            await action();
            stage.Status = "Tamam";
        }
        catch
        {
            stage.Status = "Hata";
            throw;
        }
    }

    private async Task<T> ExecuteStageAsync<T>(string name, string detail, Func<Task<T>> action)
    {
        var stage = Stage(name);
        stage.Status = "Calisiyor";
        stage.Detail = detail;
        ViewModel.StatusText = detail;

        try
        {
            var result = await action();
            stage.Status = "Tamam";
            return result;
        }
        catch
        {
            stage.Status = "Hata";
            throw;
        }
    }

    private void CompleteStage(string name, string status, string detail)
    {
        var stage = Stage(name);
        stage.Status = status;
        stage.Detail = detail;
    }

    private static string EmptyToPlaceholder(string value) =>
        string.IsNullOrWhiteSpace(value) ? "-" : value;

    private string SanitizeError(string message)
    {
        var sanitized = message;

        if (!string.IsNullOrWhiteSpace(PasswordInput.Password))
        {
            sanitized = sanitized.Replace(PasswordInput.Password, "***", StringComparison.Ordinal);
        }

        if (!string.IsNullOrWhiteSpace(ViewModel.VerificationCode))
        {
            sanitized = sanitized.Replace(ViewModel.VerificationCode, "***", StringComparison.Ordinal);
        }

        return sanitized;
    }

    private sealed record ActivationContext(DeviceInfoModel DeviceInfo, string CurrentIpAddress, bool ActivationPerformed);
}
