using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace HikSdk.SadpWpf;

public sealed class MainWindowViewModel : INotifyPropertyChanged
{
    private string _cameraAddress = "192.168.1.64";
    private string _userName = "admin";
    private string _statusText = "Tek tusla tam kurulum icin kamera bilgilerini girin ve 'Bastan Sona Kurulum' butonunu kullanin.";
    private string _errorText = "Hata yok.";
    private string _model = "-";
    private string _serialNumber = "-";
    private string _shortSerial = "-";
    private string _subSerialNumber = "-";
    private string _firmwareVersion = "-";
    private string _macAddress = "-";
    private string _currentIpAddress = "192.168.1.64";
    private string _ezvizEnabledText = "-";
    private string _registerStatusText = "-";
    private string _verificationCode = string.Empty;
    private string _backendBaseUrl = "http://127.0.0.1:5188";
    private string _areaName = string.Empty;
    private string _areaId = string.Empty;
    private string _gatewayOverride = string.Empty;
    private string _deviceId = "-";
    private bool _isBusy;
    private bool _enableDhcp;

    public string CameraAddress
    {
        get => _cameraAddress;
        set => SetField(ref _cameraAddress, value);
    }

    public string UserName
    {
        get => _userName;
        set => SetField(ref _userName, value);
    }

    public string StatusText
    {
        get => _statusText;
        set => SetField(ref _statusText, value);
    }

    public string ErrorText
    {
        get => _errorText;
        set => SetField(ref _errorText, value);
    }

    public string Model
    {
        get => _model;
        set => SetField(ref _model, value);
    }

    public string SerialNumber
    {
        get => _serialNumber;
        set => SetField(ref _serialNumber, value);
    }

    public string ShortSerial
    {
        get => _shortSerial;
        set => SetField(ref _shortSerial, value);
    }

    public string SubSerialNumber
    {
        get => _subSerialNumber;
        set => SetField(ref _subSerialNumber, value);
    }

    public string FirmwareVersion
    {
        get => _firmwareVersion;
        set => SetField(ref _firmwareVersion, value);
    }

    public string MacAddress
    {
        get => _macAddress;
        set => SetField(ref _macAddress, value);
    }

    public string CurrentIpAddress
    {
        get => _currentIpAddress;
        set => SetField(ref _currentIpAddress, value);
    }

    public string EzvizEnabledText
    {
        get => _ezvizEnabledText;
        set => SetField(ref _ezvizEnabledText, value);
    }

    public string RegisterStatusText
    {
        get => _registerStatusText;
        set => SetField(ref _registerStatusText, value);
    }

    public string VerificationCode
    {
        get => _verificationCode;
        set => SetField(ref _verificationCode, value);
    }

    public string BackendBaseUrl
    {
        get => _backendBaseUrl;
        set => SetField(ref _backendBaseUrl, value);
    }

    public string AreaName
    {
        get => _areaName;
        set => SetField(ref _areaName, value);
    }

    public string AreaId
    {
        get => _areaId;
        set => SetField(ref _areaId, value);
    }

    public string GatewayOverride
    {
        get => _gatewayOverride;
        set => SetField(ref _gatewayOverride, value);
    }

    public string DeviceId
    {
        get => _deviceId;
        set => SetField(ref _deviceId, value);
    }

    public bool IsBusy
    {
        get => _isBusy;
        set => SetField(ref _isBusy, value);
    }

    public bool EnableDhcp
    {
        get => _enableDhcp;
        set => SetField(ref _enableDhcp, value);
    }

    public ObservableCollection<NetworkInterfaceRow> NetworkInterfaces { get; } = [];

    public ObservableCollection<SetupStageRow> Stages { get; } = [];

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnPropertyChanged([CallerMemberName] string? propertyName = null)
    {
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
    }

    private void SetField<T>(ref T field, T value, [CallerMemberName] string? propertyName = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value))
        {
            return;
        }

        field = value;
        OnPropertyChanged(propertyName);
    }
}

public sealed record CameraConnectionOptions(string CameraAddress, string UserName, string Password);

public sealed record DeviceInfoModel(
    string Model,
    string SerialNumber,
    string ShortSerial,
    string SubSerialNumber,
    string FirmwareVersion,
    string MacAddress);

public sealed record ActivateStatusResult(
    bool IsActive,
    bool IsInactive,
    string SubStatusCode);

public sealed record NetworkInterfaceModel(
    string Id,
    string IpAddress,
    string SubnetMask,
    string Gateway,
    string PrimaryDns,
    string SecondaryDns,
    string DhcpMode,
    string RawXml);

public sealed record EzvizStatusModel(
    bool? Enabled,
    bool? RegisterStatus,
    bool HasVerificationCode);

public sealed record EnableEzvizResult(
    EzvizStatusModel FinalStatus,
    int PollCount,
    bool TimedOut);

public sealed record BackendAddDeviceRequest(
    string ShortSerial,
    string VerificationCode,
    string Alias,
    string AreaName);

public sealed record BackendAddDeviceResult(
    bool Success,
    string ErrorCode,
    string Message,
    string DeviceId,
    string ShortSerial,
    string Alias,
    string AreaId,
    string AreaName,
    bool DeviceAdded,
    int ImportedChannelCount,
    int TotalChannelCount,
    string DeviceStatusMessage,
    string ChannelStatusMessage);

public sealed record ProvisionedCameraRecord(
    string DeviceId,
    string ShortSerial,
    string MacAddress,
    string CurrentIpAddress,
    string Alias,
    DateTimeOffset CompletedAtUtc);

public sealed class NetworkInterfaceRow
{
    public NetworkInterfaceRow(NetworkInterfaceModel model)
    {
        Id = model.Id;
        IpAddress = model.IpAddress;
        SubnetMask = model.SubnetMask;
        Gateway = model.Gateway;
        PrimaryDns = model.PrimaryDns;
        SecondaryDns = model.SecondaryDns;
        DhcpMode = model.DhcpMode;
    }

    public string Id { get; }

    public string IpAddress { get; }

    public string SubnetMask { get; }

    public string Gateway { get; }

    public string PrimaryDns { get; }

    public string SecondaryDns { get; }

    public string DhcpMode { get; }
}

public sealed class SetupStageRow : INotifyPropertyChanged
{
    private string _status = "Bekliyor";
    private string _detail = string.Empty;

    public SetupStageRow(string name)
    {
        Name = name;
    }

    public string Name { get; }

    public string Status
    {
        get => _status;
        set
        {
            if (_status == value)
            {
                return;
            }

            _status = value;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Status)));
        }
    }

    public string Detail
    {
        get => _detail;
        set
        {
            if (_detail == value)
            {
                return;
            }

            _detail = value;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(Detail)));
        }
    }

    public event PropertyChangedEventHandler? PropertyChanged;
}

internal static class ObservableCollectionExtensions
{
    public static void SyncFrom<T>(this ObservableCollection<T> collection, IEnumerable<T> items)
    {
        collection.Clear();
        foreach (var item in items)
        {
            collection.Add(item);
        }
    }
}
