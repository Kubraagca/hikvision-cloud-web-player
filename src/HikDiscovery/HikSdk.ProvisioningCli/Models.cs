namespace HikSdk.ProvisioningCli;

public sealed record CameraConnectionOptions(string CameraAddress, string UserName, string Password);

public sealed record DiscoveredCameraInfo(
    string IpAddress,
    string MacAddress,
    string SerialNumber,
    string Model,
    string ActivationStatus,
    bool IsHikvision,
    bool SupportsIsapi,
    bool SupportsSdkPort,
    bool PingSucceeded,
    bool Port80Open,
    bool Port443Open,
    bool Port554Open,
    bool Port8000Open,
    bool Port8080Open);

public sealed record DeviceInfoModel(
    string Model,
    string SerialNumber,
    string ShortSerial,
    string SubSerialNumber,
    string FirmwareVersion,
    string MacAddress);

public sealed record ActivateStatusResult(bool IsActive, bool IsInactive, string SubStatusCode);

public sealed record NetworkInterfaceModel(
    string Id,
    string IpAddress,
    string SubnetMask,
    string Gateway,
    string PrimaryDns,
    string SecondaryDns,
    string DhcpMode,
    string RawXml);

public sealed record EzvizStatusModel(bool? Enabled, bool? RegisterStatus, bool HasVerificationCode);
public sealed record EnableEzvizResult(EzvizStatusModel FinalStatus, int PollCount, bool TimedOut);

public sealed record BackendProvisioningRequest(
    string ShortSerial,
    string VerificationCode,
    string Alias,
    string AreaName,
    string Model,
    string SerialNumber,
    string SubSerialNumber,
    string FirmwareVersion,
    string MacAddress,
    string CurrentIpAddress);

public sealed record BackendProvisioningResponse(string? Message, string? Error, BackendProvisioningResult? Result);

public sealed record BackendProvisioningResult(
    bool Success,
    string DeviceId,
    string ShortSerial,
    string Alias,
    string AreaId,
    string AreaName,
    bool DeviceAdded,
    int ImportedChannelCount,
    int TotalChannelCount,
    string DeviceStatusMessage,
    string ChannelStatusMessage,
    string Model,
    string SerialNumber,
    string SubSerialNumber,
    string FirmwareVersion,
    string MacAddress,
    string CurrentIpAddress);
