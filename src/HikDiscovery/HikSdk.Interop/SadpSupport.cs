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

public sealed record SdkErrorInfo(
    uint ErrorCode,
    string ErrorSymbol,
    string ErrorMessage);

public sealed record SadpPollResult(
    bool Success,
    string NativeFunction,
    SdkErrorInfo? Error,
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
        ConfigureSdkInitPaths();

        if (!HikSdkNative.NET_DVR_Init())
        {
            var error = CaptureLastError();
            throw new InvalidOperationException($"NET_DVR_Init failed. Error={error.ErrorCode}, Symbol={error.ErrorSymbol}, Message={error.ErrorMessage}");
        }

        _initialized = true;
    }

    public void EnableLogging(string logDirectory)
    {
        Directory.CreateDirectory(logDirectory);
        if (!HikSdkNative.NET_DVR_SetLogToFile(3, logDirectory, true))
        {
            var error = CaptureLastError();
            throw new InvalidOperationException($"NET_DVR_SetLogToFile failed. Error={error.ErrorCode}, Symbol={error.ErrorSymbol}, Message={error.ErrorMessage}");
        }
    }

    public SadpPollResult PollSadpDevices(int userId = 0)
    {
        var sadpInfoList = NET_DVR_SADPINFO_LIST.Create();
        var success = HikSdkNative.NET_DVR_GetSadpInfoList(userId, ref sadpInfoList);
        if (!success)
        {
            return new SadpPollResult(false, nameof(HikSdkNative.NET_DVR_GetSadpInfoList), CaptureLastError(), Array.Empty<SadpDeviceInfo>());
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

        return new SadpPollResult(true, nameof(HikSdkNative.NET_DVR_GetSadpInfoList), null, devices);
    }

    public static SdkErrorInfo CaptureLastError()
    {
        var errorCode = (int)HikSdkNative.NET_DVR_GetLastError();
        var code = errorCode;
        var pointer = HikSdkNative.NET_DVR_GetErrorMsg(ref code);
        var message = pointer == IntPtr.Zero
            ? "No SDK error message available."
            : Marshal.PtrToStringAnsi(pointer);

        return new SdkErrorInfo(
            unchecked((uint)errorCode),
            ResolveErrorSymbol(errorCode),
            string.IsNullOrWhiteSpace(message) ? "No SDK error message available." : message.Trim());
    }

    public static string ResolveErrorSymbol(int errorCode)
    {
        return errorCode switch
        {
            44 => "NET_DVR_CREATESOCKET_ERROR",
            45 => "NET_DVR_SETSOCKET_ERROR",
            47 => "NET_DVR_USERNOTEXIST",
            71 => "NET_DVR_CREATEDIR_ERROR",
            72 => "NET_DVR_BINDSOCKET_ERROR",
            73 => "NET_DVR_SOCKETCLOSE_ERROR",
            75 => "NET_DVR_SOCKETLISTEN_ERROR",
            107 => "NET_DVR_LOAD_HCPREVIEW_SDK_ERROR",
            108 => "NET_DVR_LOAD_HCVOICETALK_SDK_ERROR",
            109 => "NET_DVR_LOAD_HCALARM_SDK_ERROR",
            110 => "NET_DVR_LOAD_HCPLAYBACK_SDK_ERROR",
            111 => "NET_DVR_LOAD_HCDISPLAY_SDK_ERROR",
            112 => "NET_DVR_LOAD_HCINDUSTRY_SDK_ERROR",
            113 => "NET_DVR_LOAD_HCGENERALCFGMGR_SDK_ERROR",
            114 => "NET_DVR_LOAD_HCCOREDEVCFG_SDK_ERROR",
            115 => "NET_DVR_LOAD_HCNETUTILS_SDK_ERROR",
            148 => "NET_DVR_LOAD_SSL_LIB_ERROR",
            156 => "NET_DVR_LOAD_LIBEAY32_DLL_ERROR",
            157 => "NET_DVR_LOAD_SSLEAY32_DLL_ERROR",
            _ => $"UNKNOWN_{errorCode}"
        };
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

    public static void ConfigureSdkInitPaths()
    {
        var baseDirectory = AppContext.BaseDirectory;
        SetSdkInitPath(HikSdkNative.NET_SDK_INIT_CFG_TYPE.NET_SDK_INIT_CFG_SDK_PATH, baseDirectory);
        SetSdkInitPath(HikSdkNative.NET_SDK_INIT_CFG_TYPE.NET_SDK_INIT_CFG_LIBEAY_PATH, Path.Combine(baseDirectory, "libcrypto-1_1-x64.dll"));
        SetSdkInitPath(HikSdkNative.NET_SDK_INIT_CFG_TYPE.NET_SDK_INIT_CFG_SSLEAY_PATH, Path.Combine(baseDirectory, "libssl-1_1-x64.dll"));
    }

    private static void SetSdkInitPath(HikSdkNative.NET_SDK_INIT_CFG_TYPE configType, string path)
    {
        var sdkPath = NET_DVR_LOCAL_SDK_PATH.Create();
        CopyAscii(path, sdkPath.sPath);
        var pointer = Marshal.AllocHGlobal(Marshal.SizeOf<NET_DVR_LOCAL_SDK_PATH>());
        try
        {
            Marshal.StructureToPtr(sdkPath, pointer, false);
            if (!HikSdkNative.NET_DVR_SetSDKInitCfg(configType, pointer))
            {
                var error = CaptureLastError();
                throw new InvalidOperationException($"NET_DVR_SetSDKInitCfg({configType}) failed. Error={error.ErrorCode}, Symbol={error.ErrorSymbol}, Message={error.ErrorMessage}");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    private static void CopyAscii(string source, sbyte[] target)
    {
        Array.Clear(target, 0, target.Length);
        var bytes = Encoding.ASCII.GetBytes(source);
        var length = Math.Min(bytes.Length, target.Length - 1);
        for (var i = 0; i < length; i++)
        {
            target[i] = unchecked((sbyte)bytes[i]);
        }
    }
}
