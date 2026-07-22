using System.Runtime.InteropServices;
using System.Text;

namespace HikSdk.Interop;

public sealed record SadpDeviceInfo(
    string Model,
    string SerialNumber,
    string MacAddress,
    string IpAddress,
    bool DhcpEnabled,
    string ActivationStatus);

public sealed record SadpPollResult(
    bool Success,
    uint ErrorCode,
    string ErrorMessage,
    IReadOnlyList<SadpDeviceInfo> Devices);

public sealed record StructSizeValidationResult(
    string Name,
    int ExpectedSize,
    int ActualSize,
    bool IsMatch);

public static class SadpInteropValidator
{
    public static IReadOnlyList<StructSizeValidationResult> Validate()
    {
        return
        [
            Create(nameof(NET_DVR_IPADDR), 144, Marshal.SizeOf<NET_DVR_IPADDR>()),
            Create(nameof(NET_DVR_SADPINFO), 956, Marshal.SizeOf<NET_DVR_SADPINFO>()),
            Create(nameof(NET_DVR_SADPINFO_LIST), 244748, Marshal.SizeOf<NET_DVR_SADPINFO_LIST>()),
            Create(nameof(NET_DVR_SADP_VERIFY), 224, Marshal.SizeOf<NET_DVR_SADP_VERIFY>()),
            Create(nameof(NET_DVR_ACTIVATECFG), 128, Marshal.SizeOf<NET_DVR_ACTIVATECFG>())
        ];
    }

    public static void ThrowIfInvalid()
    {
        var invalid = Validate().Where(result => !result.IsMatch).ToArray();
        if (invalid.Length == 0)
        {
            return;
        }

        var details = string.Join(Environment.NewLine, invalid.Select(result =>
            $"{result.Name}: expected {result.ExpectedSize}, actual {result.ActualSize}"));
        throw new InvalidOperationException($"HCNetSDK marshaling size check failed.{Environment.NewLine}{details}");
    }

    private static StructSizeValidationResult Create(string name, int expectedSize, int actualSize) =>
        new(name, expectedSize, actualSize, expectedSize == actualSize);
}

public sealed class HikSdkSession : IDisposable
{
    private bool _initialized;

    public void Initialize()
    {
        if (_initialized)
        {
            return;
        }

        SadpInteropValidator.ThrowIfInvalid();

        if (!HikSdkNative.NET_DVR_Init())
        {
            throw new InvalidOperationException(GetLastErrorDescription("NET_DVR_Init"));
        }

        _initialized = true;
    }

    public void EnableLogging(string logDirectory)
    {
        Directory.CreateDirectory(logDirectory);
        if (!HikSdkNative.NET_DVR_SetLogToFile(3, logDirectory, true))
        {
            throw new InvalidOperationException(GetLastErrorDescription("NET_DVR_SetLogToFile"));
        }
    }

    public SadpPollResult PollSadpDevices(int userId = 0)
    {
        var sadpInfoList = NET_DVR_SADPINFO_LIST.Create();
        var success = HikSdkNative.NET_DVR_GetSadpInfoList(userId, ref sadpInfoList);
        if (!success)
        {
            var errorCode = HikSdkNative.NET_DVR_GetLastError();
            return new SadpPollResult(false, errorCode, TryGetErrorMessage((int)errorCode), Array.Empty<SadpDeviceInfo>());
        }

        var count = Math.Min(sadpInfoList.wSadpNum, (ushort)sadpInfoList.struSadpInfo.Length);
        var devices = new List<SadpDeviceInfo>(count);
        for (var i = 0; i < count; i++)
        {
            var item = sadpInfoList.struSadpInfo[i];
            devices.Add(new SadpDeviceInfo(
                DecodeByteString(item.byDeviceModel),
                DecodeSByteString(item.chSerialNo),
                FormatMac(item.byMACAddr),
                DecodeSByteString(item.struIP.sIpV4),
                item.byDhcp == 1,
                item.byActivated switch
                {
                    1 => "Active",
                    2 => "Inactive",
                    _ => $"Unknown({item.byActivated})"
                }));
        }

        return new SadpPollResult(true, 0, string.Empty, devices);
    }

    public static string GetLastErrorDescription(string operation)
    {
        var errorCode = (int)HikSdkNative.NET_DVR_GetLastError();
        return $"{operation} failed. Error={errorCode}, Message={TryGetErrorMessage(errorCode)}";
    }

    public static string TryGetErrorMessage(int errorCode)
    {
        var code = errorCode;
        var pointer = HikSdkNative.NET_DVR_GetErrorMsg(ref code);
        if (pointer == IntPtr.Zero)
        {
            return "No SDK error message available.";
        }

        var message = Marshal.PtrToStringAnsi(pointer);
        return string.IsNullOrWhiteSpace(message) ? "No SDK error message available." : message.Trim();
    }

    public void Dispose()
    {
        if (!_initialized)
        {
            return;
        }

        HikSdkNative.NET_DVR_Cleanup();
        _initialized = false;
    }

    public static string DecodeSByteString(sbyte[] buffer)
    {
        var byteBuffer = buffer.Select(value => unchecked((byte)value)).ToArray();
        return DecodeByteString(byteBuffer);
    }

    public static string DecodeByteString(byte[] buffer)
    {
        var zeroIndex = Array.IndexOf(buffer, (byte)0);
        var length = zeroIndex >= 0 ? zeroIndex : buffer.Length;
        return Encoding.ASCII.GetString(buffer, 0, length).Trim();
    }

    public static string FormatMac(byte[] macAddress)
    {
        return string.Join("-", macAddress.Select(value => value.ToString("X2")));
    }
}
